/**
 * Approvals: the requests waiting on a person (here, in this deployment's database, with the work
 * that resumes them), and the policy that decides when to ask (in Intelligence's organization policy,
 * held in memory on every server by `policy/cache.ts`).
 *
 * The policy is read on every tool call that may need approval, so it is read from memory, never
 * from Intelligence on the way. A write goes to Intelligence first and is held here from its answer,
 * so this server reads its own change at once; every other server hears of it from Intelligence.
 * No write to Intelligence is made while a transaction here is open.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../audit";
import { conversations } from "../conversations/directory";
import type { Database } from "../db/client";
import { approvalRequests } from "../db/schema/approvals";
import { workItems } from "../db/schema/work";
import { PolicyAlreadyExistsError, policyFailure } from "../policy/client";
import { policy } from "../policy/cache";
import type { ApprovalRuleRecord } from "../policy/types";
import { taskOrigin } from "../tasks/origin";
import {
  type ApprovalAction,
  ApprovalNotFoundError,
  type ApprovalPolicyStore,
  type ApprovalPreferences,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalRule,
  type ApprovalRuleInput,
  type ApprovalStore,
  type ApprovalTeamRule,
  type ApprovalTeamSettings,
  offersStandingRule,
} from "./types";

/** A personal rule as OpenBot's approval code reads it, from the record Intelligence holds. */
export function personalRuleFrom(record: ApprovalRuleRecord): ApprovalRule {
  return {
    id: record.id,
    ownerUserId: record.ownerUserId ?? "",
    botId: record.agentId,
    toolRef: record.tool,
    effect: record.effect,
    scope: record.scope,
    behaviour: record.behaviour,
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
    createdAt: new Date(record.createdAt),
  };
}

/** A team rule as OpenBot's approval code reads it. */
export function teamRuleFrom(record: ApprovalRuleRecord): ApprovalTeamRule {
  return {
    id: record.id,
    botId: record.agentId,
    toolRef: record.tool,
    effect: record.effect,
    scope: record.scope,
    behaviour: record.behaviour,
    createdBy: record.createdBy,
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
    createdAt: new Date(record.createdAt),
  };
}

const newestFirst = <T extends { createdAt: Date; id: string }>(
  left: T,
  right: T,
) =>
  right.createdAt.getTime() - left.createdAt.getTime() ||
  right.id.localeCompare(left.id);

/**
 * The "always allow" rule an approval's `allow_always` saved, at an id made from the approval, so the
 * person's one decision is one rule however many times it is sent: by a retry, or by two servers.
 */
export function standingRuleId(approvalId: string): string {
  return `approval:${approvalId}`;
}

/** Whether a rule is exactly the standing "allow" a person saved for this action. */
const standsFor = (rule: ApprovalRuleRecord, action: ApprovalAction) =>
  rule.ownerUserId === action.actorId &&
  rule.agentId === action.botId &&
  rule.tool === action.toolRef &&
  rule.effect === action.effect &&
  rule.scope === action.scope &&
  rule.behaviour === "allow" &&
  rule.revokedAt === null;

export function createApprovalStore(database: Database): ApprovalStore {
  const owned = (owner: string, id: string) =>
    and(eq(approvalRequests.ownerUserId, owner), eq(approvalRequests.id, id));
  /** From memory: the gate's path. */
  const standingRule = (action: ApprovalAction) =>
    policy()
      .approvalRules({ ownerUserId: action.actorId })
      .find((rule) => standsFor(rule, action));
  async function get(owner: string, id: string): Promise<ApprovalRecord> {
    const [row] = await database
      .select()
      .from(approvalRequests)
      .where(owned(owner, id))
      .limit(1);
    if (!row) throw new ApprovalNotFoundError();
    return row;
  }
  return {
    async enabled(owner) {
      return policy().approvalPreferences(owner).enabled;
    },
    async setEnabled(owner, enabled) {
      await policy().patchApprovalPreferences(owner, { enabled });
    },
    get,
    async list(owner) {
      return database
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.ownerUserId, owner))
        .orderBy(desc(approvalRequests.createdAt))
        .limit(100);
    },
    async open(action) {
      return database.transaction(async (tx) => {
        // A request the policy gate opened was opened because something asked for the person; a
        // saved "always" rule was already weighed there and must not approve it behind that.
        const rule = action.policy ? undefined : standingRule(action);
        await tx
          .insert(approvalRequests)
          .values({
            id: crypto.randomUUID(),
            ownerUserId: action.actorId,
            runId: action.runId,
            toolCallId: action.toolCallId,
            actionDigest: action.actionDigest,
            action,
            status: rule ? "approved" : "pending",
            decision: rule ? "allow_always" : null,
            decidedAt: rule ? sql`now()` : null,
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.ownerUserId, action.actorId),
              eq(approvalRequests.runId, action.runId),
              eq(approvalRequests.toolCallId, action.toolCallId),
            ),
          )
          .limit(1);
        if (!row) throw new ApprovalNotFoundError();
        if (row.actionDigest !== action.actionDigest)
          throw new ApprovalRefusedError("The approved action has changed.");
        return row;
      });
    },
    async decide(owner, id, decision) {
      /*
       * "Always allow" saves a standing rule in Intelligence, and the decision itself is a row here
       * with the work that resumes it. They cannot share a transaction, so the rule is saved FIRST,
       * at an id made from this approval: by the time the resume work can run, on any server, the rule
       * it checks for is already in Intelligence. If the decision then does not go through (somebody
       * decided first), the rule is taken back unless that other decision saved the same rule.
       */
      let saved: ApprovalRuleRecord | undefined;
      if (decision === "allow_always") {
        const request = await get(owner, id);
        if (request.status !== "pending")
          throw new ApprovalRefusedError("This request was already decided.");
        if (request.action.policy?.behaviour === "hand_off")
          throw new ApprovalRefusedError(
            "This action is handed to you. Do it yourself and mark it done, or decline it.",
          );
        if (!offersStandingRule(request.action))
          throw new ApprovalRefusedError(
            "Tasks started from a check-in ask before every change. Allow this once, or deny it.",
          );
        saved = await saveStandingRule(owner, id, request.action);
      }
      try {
        return await database.transaction(async (tx) => {
          const [request] = await tx
            .select()
            .from(approvalRequests)
            .where(owned(owner, id))
            .for("update")
            .limit(1);
          if (!request) throw new ApprovalNotFoundError();
          if (request.status !== "pending")
            throw new ApprovalRefusedError("This request was already decided.");
          const handOff = request.action.policy?.behaviour === "hand_off";
          if (handOff && decision !== "handled" && decision !== "deny")
            throw new ApprovalRefusedError(
              "This action is handed to you. Do it yourself and mark it done, or decline it.",
            );
          if (!handOff && decision === "handled")
            throw new ApprovalRefusedError(
              "Only an action handed to you can be marked done by you.",
            );
          if (
            decision === "allow_always" &&
            !offersStandingRule(request.action)
          )
            throw new ApprovalRefusedError(
              "Tasks started from a check-in ask before every change. Allow this once, or deny it.",
            );
          const [updated] = await tx
            .update(approvalRequests)
            .set({
              decision,
              status: decision === "deny" ? "denied" : "approved",
              decidedAt: sql`now()`,
            })
            .where(owned(owner, id))
            .returning();
          if (!updated) throw new ApprovalNotFoundError();
          await recordAuditEvent(createAuditStore(tx as unknown as Database), {
            eventType: "approval.person_decided",
            targetType: "approval",
            targetId: id,
            actorUserId: owner,
            payload: {
              decidedBy: "person",
              decision,
              bot: request.action.botId,
              tool: request.action.toolRef,
              scope: request.action.scope,
            },
          });
          await tx
            .insert(workItems)
            .values({
              kind: "approval.resume",
              key: id,
              payload: { ownerUserId: owner, approvalId: id },
            })
            .onConflictDoNothing();
          await tx.execute(
            sql`select pg_notify('openbot_work_offered', 'approval.resume')`,
          );
          return updated;
        });
      } catch (error) {
        if (saved) await withdrawStandingRule(owner, id, saved);
        throw error;
      }
    },
    async consume(owner, id, digest) {
      return database.transaction(async (tx) => {
        const [request] = await tx
          .select()
          .from(approvalRequests)
          .where(owned(owner, id))
          .for("update")
          .limit(1);
        if (!request) throw new ApprovalNotFoundError();
        if (request.actionDigest !== digest)
          throw new ApprovalRefusedError("The approved action has changed.");
        if (request.status !== "approved") return false;
        // Read from Intelligence, not memory: the rule may have been saved on another server a moment
        // ago, and this is the resume path, never the gate's. Revoked since, and nothing runs.
        if (
          request.decision === "allow_always" &&
          !(await policy().readApprovalRules(owner)).some((rule) =>
            standsFor(rule, request.action),
          )
        )
          return false;
        const rows = await tx
          .update(approvalRequests)
          .set({ status: "consumed", consumedAt: sql`now()` })
          .where(and(owned(owner, id), eq(approvalRequests.status, "approved")))
          .returning({ id: approvalRequests.id });
        return rows.length === 1;
      });
    },
    async saveResult(owner, id, result) {
      const rows = await database
        .update(approvalRequests)
        .set({ result })
        .where(and(owned(owner, id), isNull(approvalRequests.result)))
        .returning({ id: approvalRequests.id });
      if (!rows.length) await get(owner, id);
      return rows.length > 0;
    },
    async finish(owner, id) {
      const rows = await database
        .update(approvalRequests)
        .set({ status: "completed", completedAt: sql`now()` })
        .where(owned(owner, id))
        .returning({ id: approvalRequests.id });
      if (!rows.length) throw new ApprovalNotFoundError();
    },
    async rules(owner) {
      return policy()
        .approvalRules({ ownerUserId: owner })
        .map(personalRuleFrom)
        .sort(newestFirst);
    },
    policy: createPolicyStore(database),
    /*
     * A check-in task's conversation, found by the thread an action names: the task's own turn, the
     * turn an approval carries on, and the person replying there all run in that thread. Started from
     * a check-in, so it is work the person did not write out themselves, and every step in it asks
     * but a read of their own connected app (see `gate` in approvals/service.ts).
     */
    async asksEveryChange(owner, threadId) {
      // Read on every gated tool call: the thread's conversation and the task that owns it come from
      // this instance's memory (conversations/directory.ts, tasks/origin.ts), not a round trip.
      const found = await conversations().byThread(threadId);
      if (
        !found ||
        found.thread.agentId !== null ||
        found.thread.userId !== owner ||
        !found.conversation.taskId
      )
        return false;
      const task = await taskOrigin(found.conversation.taskId);
      return task?.userId === owner && task.origin === "check_in";
    },
    async revoke(owner, id) {
      const rule = await ownRule(owner, id);
      await policy().revokeApprovalRule(rule.id);
    },
  };

  /**
   * Save the standing rule an "always allow" makes. Sent again, by a retry or a second server, it is
   * the same rule: the id is made from the approval, so a second create finds it already there.
   */
  async function saveStandingRule(
    owner: string,
    approvalId: string,
    action: ApprovalAction,
  ): Promise<ApprovalRuleRecord> {
    const draft = {
      id: standingRuleId(approvalId),
      ownerUserId: owner,
      agentId: action.botId,
      tool: action.toolRef,
      effect: action.effect,
      scope: action.scope,
      behaviour: "allow" as const,
      createdBy: owner,
    };
    try {
      return await policy().createApprovalRule(
        draft,
        `openbot:approval-always:${approvalId}`,
      );
    } catch (error) {
      if (!(error instanceof PolicyAlreadyExistsError)) throw error;
      const existing = await policy().client.approvalRule(draft.id);
      if (!existing) throw error;
      return existing;
    }
  }

  /**
   * The decision did not go through: take back the rule saved for it, unless the decision that did go
   * through was an "always allow" too, which saved this same rule.
   */
  async function withdrawStandingRule(
    owner: string,
    approvalId: string,
    rule: ApprovalRuleRecord,
  ): Promise<void> {
    try {
      const [row] = await database
        .select({ decision: approvalRequests.decision })
        .from(approvalRequests)
        .where(owned(owner, approvalId))
        .limit(1);
      if (row?.decision === "allow_always") return;
      await policy().revokeApprovalRule(rule.id);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "approval-standing-rule-withdraw-failed",
          approvalId,
          ruleId: rule.id,
          note: "The decision failed after its rule was saved; the rule stays until the person revokes it.",
          error: policyFailure(error),
        }),
      );
    }
  }

  /** One of this person's rules in force, from memory, read through on a miss. Another person's is not found. */
  async function ownRule(
    owner: string,
    id: string,
  ): Promise<ApprovalRuleRecord> {
    const held =
      policy().approvalRule(id) ??
      (await policy().readApprovalRules(owner)).find((rule) => rule.id === id);
    if (!held || held.ownerUserId !== owner || held.revokedAt !== null)
      throw new ApprovalNotFoundError();
    return held;
  }
}

function createPolicyStore(database: Database): ApprovalPolicyStore {
  const audit = createAuditStore(database);
  /** From memory: read on every tool call that may need approval. */
  const preferences = async (owner: string): Promise<ApprovalPreferences> => {
    const held = policy().approvalPreferences(owner);
    return {
      enabled: held.enabled,
      autoReview: held.autoReview,
      hostCommands: held.hostCommands,
    };
  };
  const teamSettings = async (): Promise<ApprovalTeamSettings> => ({
    ...policy().settings().approvals,
  });
  /** A team rule in force, from memory, read through on a miss. */
  const teamRule = async (id: string): Promise<ApprovalRuleRecord> => {
    const held =
      policy().approvalRule(id) ?? (await policy().client.approvalRule(id));
    if (!held || held.ownerUserId !== null || held.revokedAt !== null)
      throw new ApprovalNotFoundError();
    return held;
  };
  /** One of this person's rules in force, from memory, read through on a miss. */
  const personalRule = async (
    owner: string,
    id: string,
  ): Promise<ApprovalRuleRecord> => {
    const held =
      policy().approvalRule(id) ?? (await policy().client.approvalRule(id));
    if (!held || held.ownerUserId !== owner || held.revokedAt !== null)
      throw new ApprovalNotFoundError();
    return held;
  };
  return {
    preferences,
    async setPreferences(owner, input) {
      const saved = await policy().patchApprovalPreferences(owner, input);
      const next: ApprovalPreferences = {
        enabled: saved.enabled,
        autoReview: saved.autoReview,
        hostCommands: saved.hostCommands,
      };
      // On the trail like team settings: turning "ask before making changes" off is a governance
      // change, and without a row nobody could say when or by whom it happened.
      await recordAuditEvent(audit, {
        eventType: "approval.settings_changed",
        targetType: "approval_settings",
        targetId: owner,
        actorUserId: owner,
        payload: { changed: input, settings: next, layer: "personal" },
      });
      return next;
    },
    teamSettings,
    async setTeamSettings(by, input) {
      const saved = await policy().patchSettings({
        approvals: input,
        updatedBy: by,
      });
      const next = { ...saved.approvals };
      await recordAuditEvent(audit, {
        eventType: "approval.settings_changed",
        targetType: "approval_settings",
        targetId: "team",
        actorUserId: by,
        payload: { changed: input, settings: next },
      });
      return next;
    },
    async teamRules() {
      return policy()
        .approvalRules({ ownerUserId: null })
        .map(teamRuleFrom)
        .sort(newestFirst);
    },
    async createRule(owner, input) {
      const record = await policy().createApprovalRule({
        id: randomUUID(),
        ownerUserId: owner,
        agentId: input.botId,
        tool: input.toolRef,
        effect: input.effect,
        scope: input.scope,
        behaviour: input.behaviour,
        createdBy: owner,
      });
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: record.id,
        actorUserId: owner,
        payload: { change: "created", layer: "personal", rule: input },
      });
      return personalRuleFrom(record);
    },
    async createTeamRule(by, input) {
      const record = await policy().createApprovalRule({
        id: randomUUID(),
        ownerUserId: null,
        agentId: input.botId,
        tool: input.toolRef,
        effect: input.effect,
        scope: input.scope,
        behaviour: input.behaviour,
        createdBy: by,
      });
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: record.id,
        actorUserId: by,
        payload: { change: "created", layer: "team", rule: input },
      });
      return teamRuleFrom(record);
    },
    async updateRule(owner, id, input) {
      await personalRule(owner, id);
      const record = await policy().patchApprovalRule(id, rulePatch(input));
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: id,
        actorUserId: owner,
        payload: { change: "updated", layer: "personal", changed: input },
      });
      return personalRuleFrom(record);
    },
    async updateTeamRule(by, id, input) {
      await teamRule(id);
      const record = await policy().patchApprovalRule(id, rulePatch(input));
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: id,
        actorUserId: by,
        payload: { change: "updated", layer: "team", changed: input },
      });
      return teamRuleFrom(record);
    },
    async revokeTeamRule(by, id) {
      await teamRule(id);
      await policy().revokeApprovalRule(id);
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: id,
        actorUserId: by,
        payload: { change: "revoked", layer: "team" },
      });
    },
    async findEquivalent(input) {
      const [row] = await database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, input.ownerUserId),
            sql`${approvalRequests.action}->>'threadId' = ${input.threadId}`,
            sql`${approvalRequests.action}->>'equivalence' = ${input.equivalence}`,
            sql`${approvalRequests.toolCallId} <> ${input.excludeToolCallId}`,
          ),
        )
        .orderBy(desc(approvalRequests.createdAt))
        .limit(1);
      return row;
    },
    async withdrawPending(owner, reason, match, options = {}) {
      const pending = await database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, owner),
            eq(approvalRequests.status, "pending"),
          ),
        );
      const withdrawn: string[] = [];
      for (const request of pending.filter((row) => match(row.action))) {
        const done = await database.transaction(async (tx) => {
          const rows = await tx
            .update(approvalRequests)
            .set({
              status: "denied",
              result: { content: reason, error: reason },
              decidedAt: sql`now()`,
            })
            .where(
              and(
                eq(approvalRequests.ownerUserId, owner),
                eq(approvalRequests.id, request.id),
                eq(approvalRequests.status, "pending"),
              ),
            )
            .returning({ id: approvalRequests.id });
          if (!rows.length) return false;
          if (options.resume === false) return true;
          // The waiting conversation resumes with the reason as its result; nothing is executed.
          await tx
            .insert(workItems)
            .values({
              kind: "approval.resume",
              key: request.id,
              payload: { ownerUserId: owner, approvalId: request.id },
            })
            .onConflictDoNothing();
          await tx.execute(
            sql`select pg_notify('openbot_work_offered', 'approval.resume')`,
          );
          return true;
        });
        if (!done) continue;
        withdrawn.push(request.id);
        await recordAuditEvent(audit, {
          eventType: "approval.withdrawn",
          targetType: "approval",
          targetId: request.id,
          actorUserId: owner,
          payload: {
            bot: request.action.botId,
            tool: request.action.toolRef,
            reason,
          },
        });
      }
      return withdrawn;
    },
    async recordDecision(input) {
      await recordAuditEvent(audit, {
        eventType: "approval.evaluated",
        targetType: "approval",
        targetId: input.toolRef,
        actorUserId: input.ownerUserId,
        ...(input.initiator ? { initiator: input.initiator } : {}),
        payload: {
          decidedBy: "policy",
          bot: input.botId,
          tool: input.toolRef,
          effect: input.effect,
          scope: input.scope,
          outcome: input.outcome,
        },
      });
    },
  };
}

/** OpenBot's names for a rule's action class, as Intelligence's. */
function rulePatch(input: Partial<ApprovalRuleInput>) {
  return {
    ...(input.botId !== undefined ? { agentId: input.botId } : {}),
    ...(input.toolRef !== undefined ? { tool: input.toolRef } : {}),
    ...(input.effect !== undefined ? { effect: input.effect } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.behaviour !== undefined ? { behaviour: input.behaviour } : {}),
  };
}
