import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  approvalPreferences,
  approvalRequests,
  approvalRules,
  approvalTeamRules,
  approvalTeamSettings,
} from "../db/schema/approvals";
import { workItems } from "../db/schema/work";
import {
  type ApprovalAction,
  ApprovalNotFoundError,
  type ApprovalPolicyStore,
  type ApprovalPreferences,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalStore,
  type ApprovalTeamSettings,
} from "./types";

const TEAM = "team";
const DEFAULT_PREFERENCES: ApprovalPreferences = {
  enabled: false,
  autoReview: false,
  hostCommands: "ask",
};
const DEFAULT_TEAM: ApprovalTeamSettings = {
  enforceAutoReview: false,
  customRulesEnabled: true,
  hostCommandsCap: "allow",
};

export function createApprovalStore(database: Database): ApprovalStore {
  const owned = (owner: string, id: string) =>
    and(eq(approvalRequests.ownerUserId, owner), eq(approvalRequests.id, id));
  const ruleScope = (action: ApprovalAction) =>
    and(
      eq(approvalRules.ownerUserId, action.actorId),
      eq(approvalRules.botId, action.botId),
      eq(approvalRules.toolRef, action.toolRef),
      eq(approvalRules.effect, action.effect),
      eq(approvalRules.scope, action.scope),
      eq(approvalRules.behaviour, "allow"),
      isNull(approvalRules.revokedAt),
    );
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
      const [row] = await database
        .select()
        .from(approvalPreferences)
        .where(eq(approvalPreferences.ownerUserId, owner))
        .limit(1);
      return row?.enabled === true;
    },
    async setEnabled(owner, enabled) {
      await database
        .insert(approvalPreferences)
        .values({ ownerUserId: owner, enabled })
        .onConflictDoUpdate({
          target: approvalPreferences.ownerUserId,
          set: { enabled },
        });
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
        const [rule] = action.policy
          ? []
          : await tx
              .select()
              .from(approvalRules)
              .where(ruleScope(action))
              .limit(1);
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
      return database.transaction(async (tx) => {
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
        if (decision === "allow_always")
          await tx.insert(approvalRules).values({
            id: crypto.randomUUID(),
            ownerUserId: owner,
            botId: request.action.botId,
            toolRef: request.action.toolRef,
            effect: request.action.effect,
            scope: request.action.scope,
          });
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
        if (request.decision === "allow_always") {
          const [rule] = await tx
            .select()
            .from(approvalRules)
            .where(ruleScope(request.action))
            .for("share")
            .limit(1);
          if (!rule) return false;
        }
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
      return database
        .select()
        .from(approvalRules)
        .where(
          and(
            eq(approvalRules.ownerUserId, owner),
            isNull(approvalRules.revokedAt),
          ),
        )
        .orderBy(desc(approvalRules.createdAt));
    },
    policy: createPolicyStore(database),
    async revoke(owner, id) {
      const rows = await database
        .update(approvalRules)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(approvalRules.ownerUserId, owner),
            eq(approvalRules.id, id),
            isNull(approvalRules.revokedAt),
          ),
        )
        .returning({ id: approvalRules.id });
      if (!rows.length) throw new ApprovalNotFoundError();
    },
  };
}

function createPolicyStore(database: Database): ApprovalPolicyStore {
  const audit = createAuditStore(database);
  const preferences = async (owner: string): Promise<ApprovalPreferences> => {
    const [row] = await database
      .select()
      .from(approvalPreferences)
      .where(eq(approvalPreferences.ownerUserId, owner))
      .limit(1);
    return row
      ? {
          enabled: row.enabled,
          autoReview: row.autoReview,
          hostCommands: row.hostCommands,
        }
      : { ...DEFAULT_PREFERENCES };
  };
  const teamSettings = async (): Promise<ApprovalTeamSettings> => {
    const [row] = await database
      .select()
      .from(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, TEAM))
      .limit(1);
    return row
      ? {
          enforceAutoReview: row.enforceAutoReview,
          customRulesEnabled: row.customRulesEnabled,
          hostCommandsCap: row.hostCommandsCap,
        }
      : { ...DEFAULT_TEAM };
  };
  return {
    preferences,
    async setPreferences(owner, input) {
      const next = { ...(await preferences(owner)), ...input };
      await database
        .insert(approvalPreferences)
        .values({ ownerUserId: owner, ...next })
        .onConflictDoUpdate({
          target: approvalPreferences.ownerUserId,
          set: next,
        });
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
      const next = { ...(await teamSettings()), ...input };
      await database
        .insert(approvalTeamSettings)
        .values({ id: TEAM, ...next, updatedBy: by })
        .onConflictDoUpdate({
          target: approvalTeamSettings.id,
          set: { ...next, updatedBy: by, updatedAt: sql`now()` },
        });
      await recordAuditEvent(audit, {
        eventType: "approval.settings_changed",
        targetType: "approval_settings",
        targetId: TEAM,
        actorUserId: by,
        payload: { changed: input, settings: next },
      });
      return next;
    },
    async teamRules() {
      return database
        .select()
        .from(approvalTeamRules)
        .where(isNull(approvalTeamRules.revokedAt))
        .orderBy(desc(approvalTeamRules.createdAt));
    },
    async createRule(owner, input) {
      const [row] = await database
        .insert(approvalRules)
        .values({ id: crypto.randomUUID(), ownerUserId: owner, ...input })
        .returning();
      if (!row) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: row.id,
        actorUserId: owner,
        payload: { change: "created", layer: "personal", rule: input },
      });
      return row;
    },
    async createTeamRule(by, input) {
      const [row] = await database
        .insert(approvalTeamRules)
        .values({ id: crypto.randomUUID(), createdBy: by, ...input })
        .returning();
      if (!row) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: row.id,
        actorUserId: by,
        payload: { change: "created", layer: "team", rule: input },
      });
      return row;
    },
    async updateRule(owner, id, input) {
      const [row] = await database
        .update(approvalRules)
        .set(input)
        .where(
          and(
            eq(approvalRules.ownerUserId, owner),
            eq(approvalRules.id, id),
            isNull(approvalRules.revokedAt),
          ),
        )
        .returning();
      if (!row) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: id,
        actorUserId: owner,
        payload: { change: "updated", layer: "personal", changed: input },
      });
      return row;
    },
    async updateTeamRule(by, id, input) {
      const [row] = await database
        .update(approvalTeamRules)
        .set(input)
        .where(
          and(
            eq(approvalTeamRules.id, id),
            isNull(approvalTeamRules.revokedAt),
          ),
        )
        .returning();
      if (!row) throw new ApprovalNotFoundError();
      await recordAuditEvent(audit, {
        eventType: "approval.rule_changed",
        targetType: "approval_rule",
        targetId: id,
        actorUserId: by,
        payload: { change: "updated", layer: "team", changed: input },
      });
      return row;
    },
    async revokeTeamRule(by, id) {
      const rows = await database
        .update(approvalTeamRules)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(approvalTeamRules.id, id),
            isNull(approvalTeamRules.revokedAt),
          ),
        )
        .returning({ id: approvalTeamRules.id });
      if (!rows.length) throw new ApprovalNotFoundError();
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
    async withdrawPending(owner, reason, match) {
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
