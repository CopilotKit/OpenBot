import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { AuditInitiator } from "../audit";
import { type AuditStore, recordAuditEvent } from "../audit";
import { createRoleRepository } from "../auth/guards";
import type { OpenBotRole } from "../auth/roles";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  mcpServers,
  pluginGrants,
  responsibilities,
  responsibilityTriggers,
  sharedUseApprovalMembers,
  sharedUseApprovals,
  sharedUseRequests,
  teamBotAssignments,
  teamBotAudience,
  teamBotPublications,
  users,
} from "../db/schema";
import {
  type ActorFacts,
  type ApprovalMember,
  admits,
  type BotFacts,
  covers,
  exposureOf,
  type SharedUseApproval,
  steeringOf,
} from "./shared-use";

export class SharedUseRequestDecidedError extends Error {
  constructor() {
    super("That request has already been decided.");
    this.name = "SharedUseRequestDecidedError";
  }
}

export type SharedUseRequestRow = {
  id: string;
  botId: string;
  botName: string;
  ownerUserId: string | null;
  serverId: string;
  title: string;
  proposed: SharedUseApproval;
  current: SharedUseApproval | null;
  reason: string;
  requestedBy: string;
  status: string;
  createdAt: string;
};

export type SharedUseGate = (input: {
  botId: string;
  serverId: string;
  title: string;
  actorId: string;
  initiator?: AuditInitiator;
}) => Promise<{ allowed: true } | { allowed: false; message: string }>;

const sameApproval = (left: SharedUseApproval, right: SharedUseApproval) =>
  covers(left, right) && covers(right, left);

export function createSharedUseStore(database: Database) {
  const roles = createRoleRepository(database);

  async function approvalFor(
    botId: string,
    serverId: string,
  ): Promise<SharedUseApproval | null> {
    const [row] = await database
      .select()
      .from(sharedUseApprovals)
      .where(
        and(
          eq(sharedUseApprovals.agentId, botId),
          eq(sharedUseApprovals.serverId, serverId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const members = await database
      .select({
        kind: sharedUseApprovalMembers.kind,
        value: sharedUseApprovalMembers.value,
      })
      .from(sharedUseApprovalMembers)
      .where(
        and(
          eq(sharedUseApprovalMembers.agentId, botId),
          eq(sharedUseApprovalMembers.serverId, serverId),
        ),
      );
    return {
      audience: row.audience,
      outsideInput: row.outsideInput,
      members: members as ApprovalMember[],
    };
  }

  async function setApproval(input: {
    botId: string;
    serverId: string;
    approval: SharedUseApproval;
    by: string;
  }) {
    await database.transaction(async (tx) => {
      await tx
        .insert(sharedUseApprovals)
        .values({
          agentId: input.botId,
          serverId: input.serverId,
          audience: input.approval.audience,
          outsideInput: input.approval.outsideInput,
          approvedBy: input.by,
        })
        .onConflictDoUpdate({
          target: [sharedUseApprovals.agentId, sharedUseApprovals.serverId],
          set: {
            audience: input.approval.audience,
            outsideInput: input.approval.outsideInput,
            approvedBy: input.by,
            approvedAt: new Date(),
          },
        });
      await tx
        .delete(sharedUseApprovalMembers)
        .where(
          and(
            eq(sharedUseApprovalMembers.agentId, input.botId),
            eq(sharedUseApprovalMembers.serverId, input.serverId),
          ),
        );
      if (
        input.approval.audience === "people" &&
        input.approval.members.length > 0
      ) {
        await tx.insert(sharedUseApprovalMembers).values(
          input.approval.members.map((member) => ({
            agentId: input.botId,
            serverId: input.serverId,
            ...member,
          })),
        );
      }
      /* A pending request this approval now answers is closed as approved, so the inbox never asks twice. */
      const pending = await tx
        .select()
        .from(sharedUseRequests)
        .where(
          and(
            eq(sharedUseRequests.agentId, input.botId),
            eq(sharedUseRequests.serverId, input.serverId),
            eq(sharedUseRequests.status, "pending"),
          ),
        );
      for (const request of pending) {
        const proposed = {
          audience: request.proposedAudience,
          outsideInput: request.proposedOutsideInput,
          members: request.proposedMembers,
        };
        if (covers(input.approval, proposed)) {
          await tx
            .update(sharedUseRequests)
            .set({
              status: "approved",
              decidedBy: input.by,
              decidedAt: new Date(),
            })
            .where(eq(sharedUseRequests.id, request.id));
        }
      }
    });
  }

  async function deleteApprovalsFor(serverId: string) {
    await database
      .delete(sharedUseApprovals)
      .where(eq(sharedUseApprovals.serverId, serverId));
  }

  async function sourcesOf(responsibilityId: string): Promise<string[]> {
    const [goal] = await database
      .select({ subscriptions: responsibilities.subscriptions })
      .from(responsibilities)
      .where(eq(responsibilities.id, responsibilityId))
      .limit(1);
    const triggers = await database
      .select({ kind: responsibilityTriggers.kind })
      .from(responsibilityTriggers)
      .where(eq(responsibilityTriggers.responsibilityId, responsibilityId));
    return [
      ...triggers.map((row) => row.kind),
      ...(goal?.subscriptions ?? []).map((row) => row.source),
    ];
  }

  async function botFacts(botId: string): Promise<BotFacts> {
    const [profile] = await database
      .select({
        ownerUserId: agentProfiles.ownerUserId,
        visibility: agentProfiles.visibility,
      })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId))
      .limit(1);
    const [published] = await database
      .select({ audience: teamBotPublications.audience })
      .from(teamBotPublications)
      .where(eq(teamBotPublications.agentId, botId))
      .limit(1);
    const listed =
      published?.audience === "people"
        ? await database
            .select({
              kind: teamBotAudience.kind,
              value: teamBotAudience.value,
            })
            .from(teamBotAudience)
            .where(eq(teamBotAudience.agentId, botId))
        : [];
    const assigned = await database
      .select({ group: teamBotAssignments.groupName })
      .from(teamBotAssignments)
      .where(eq(teamBotAssignments.agentId, botId));
    const goals = await database
      .select({ id: responsibilities.id })
      .from(responsibilities)
      .where(eq(responsibilities.agentId, botId));
    const sources = (
      await Promise.all(goals.map((goal) => sourcesOf(goal.id)))
    ).flat();
    return {
      /* A Bot with no profile is a package Bot: public and ownerless. */
      ownerUserId: profile?.ownerUserId ?? null,
      visibility: profile?.visibility ?? "public",
      publication: published
        ? { audience: published.audience, members: listed as ApprovalMember[] }
        : null,
      assignments: assigned.map((row) => row.group),
      sources,
    };
  }

  async function actorFacts(actorId: string): Promise<ActorFacts> {
    const [row] = await database
      .select({ groups: users.groups })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);
    const held = await roles
      .rolesForUser(actorId)
      .catch((): OpenBotRole[] => []);
    return {
      actorId,
      isAdmin: held.includes("admin"),
      groups: row?.groups ?? [],
    };
  }

  async function sharedAppsHeldBy(botId: string) {
    const grants = await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "mcp"), eq(pluginGrants.agentId, botId)),
      );
    const serverIds = [
      ...new Set(grants.map((grant) => grant.ref.split("/")[0] ?? "")),
    ].filter(Boolean);
    if (serverIds.length === 0) return [];
    return database
      .select({ serverId: mcpServers.id, title: mcpServers.title })
      .from(mcpServers)
      .where(
        and(
          inArray(mcpServers.id, serverIds),
          eq(mcpServers.accountMode, "shared"),
        ),
      );
  }

  async function botsHolding(serverId: string): Promise<string[]> {
    const rows = await database
      .selectDistinct({ agentId: pluginGrants.agentId })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "mcp"),
          like(pluginGrants.ref, `${serverId}/%`),
        ),
      );
    return rows.map((row) => row.agentId);
  }

  async function shortfall(botId: string) {
    const needed = exposureOf(await botFacts(botId));
    const held = await sharedAppsHeldBy(botId);
    const short: {
      serverId: string;
      title: string;
      needed: SharedUseApproval;
    }[] = [];
    for (const app of held) {
      if (!covers(await approvalFor(botId, app.serverId), needed))
        short.push({ ...app, needed });
    }
    return short;
  }

  async function reapprove(botId: string, by: string) {
    const short = await shortfall(botId);
    for (const app of short)
      await setApproval({
        botId,
        serverId: app.serverId,
        approval: app.needed,
        by,
      });
    return short.map(({ serverId, title }) => ({ serverId, title }));
  }

  async function fileRequest(input: {
    botId: string;
    serverId: string;
    reason: "publish" | "trigger" | "grant" | "refused_call";
    requestedBy: string;
    proposed: SharedUseApproval;
  }): Promise<{ id: string; created: boolean }> {
    return database.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(sharedUseRequests)
        .where(
          and(
            eq(sharedUseRequests.agentId, input.botId),
            eq(sharedUseRequests.serverId, input.serverId),
            eq(sharedUseRequests.status, "pending"),
          ),
        )
        .for("update")
        .limit(1);
      if (pending) {
        const proposed = {
          audience: pending.proposedAudience,
          outsideInput: pending.proposedOutsideInput,
          members: pending.proposedMembers,
        };
        if (sameApproval(proposed, input.proposed))
          return { id: pending.id, created: false };
        await tx
          .update(sharedUseRequests)
          .set({ status: "superseded" })
          .where(eq(sharedUseRequests.id, pending.id));
      }
      const id = randomUUID();
      await tx.insert(sharedUseRequests).values({
        id,
        agentId: input.botId,
        serverId: input.serverId,
        reason: input.reason,
        requestedBy: input.requestedBy,
        proposedAudience: input.proposed.audience,
        proposedOutsideInput: input.proposed.outsideInput,
        proposedMembers: input.proposed.members,
      });
      return { id, created: true };
    });
  }

  async function rows(
    where: ReturnType<typeof and> | ReturnType<typeof eq>,
  ): Promise<SharedUseRequestRow[]> {
    const found = await database
      .select({
        request: sharedUseRequests,
        botName: agents.name,
        ownerUserId: agentProfiles.ownerUserId,
        title: mcpServers.title,
      })
      .from(sharedUseRequests)
      .innerJoin(agents, eq(agents.id, sharedUseRequests.agentId))
      .leftJoin(
        agentProfiles,
        eq(agentProfiles.agentId, sharedUseRequests.agentId),
      )
      .innerJoin(mcpServers, eq(mcpServers.id, sharedUseRequests.serverId))
      .where(where)
      .orderBy(sql`${sharedUseRequests.createdAt} desc`);
    return Promise.all(
      found.map(async ({ request, botName, ownerUserId, title }) => ({
        id: request.id,
        botId: request.agentId,
        botName,
        ownerUserId: ownerUserId ?? null,
        serverId: request.serverId,
        title,
        proposed: {
          audience: request.proposedAudience,
          outsideInput: request.proposedOutsideInput,
          members: request.proposedMembers,
        },
        current: await approvalFor(request.agentId, request.serverId),
        reason: request.reason,
        requestedBy: request.requestedBy,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
      })),
    );
  }

  const listRequests = (status?: "pending") =>
    rows(status ? eq(sharedUseRequests.status, status) : (sql`true` as never));
  const pendingFor = (botId: string) =>
    rows(
      and(
        eq(sharedUseRequests.agentId, botId),
        eq(sharedUseRequests.status, "pending"),
      ),
    );

  async function decide(input: {
    id: string;
    by: string;
    decision: "approve" | "decline";
  }) {
    const [claimed] = await database
      .update(sharedUseRequests)
      .set({
        status: input.decision === "approve" ? "approved" : "declined",
        decidedBy: input.by,
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(sharedUseRequests.id, input.id),
          eq(sharedUseRequests.status, "pending"),
        ),
      )
      .returning();
    if (!claimed) throw new SharedUseRequestDecidedError();
    if (input.decision === "approve") {
      await setApproval({
        botId: claimed.agentId,
        serverId: claimed.serverId,
        by: input.by,
        approval: {
          audience: claimed.proposedAudience,
          outsideInput: claimed.proposedOutsideInput,
          members: claimed.proposedMembers,
        },
      });
    }
    const [row] = await rows(eq(sharedUseRequests.id, input.id));
    return row!;
  }

  return {
    approvalFor,
    setApproval,
    deleteApprovalsFor,
    botFacts,
    actorFacts,
    sourcesOf,
    sharedAppsHeldBy,
    botsHolding,
    shortfall,
    reapprove,
    fileRequest,
    listRequests,
    pendingFor,
    decide,
  };
}

export type SharedUseStore = ReturnType<typeof createSharedUseStore>;

export function createSharedUseGate(
  store: SharedUseStore,
  audit: AuditStore,
): SharedUseGate {
  return async ({ botId, serverId, title, actorId, initiator }) => {
    const message = `This Bot is reachable by more people than an administrator approved for the shared ${title} account. An administrator has been asked to approve it.`;
    const steering = await steeringOf(initiator, store.sourcesOf);
    const facts = await store.botFacts(botId);
    const approval = await store.approvalFor(botId, serverId);
    if (steering.kind === "actor" && approval) {
      if (
        admits(
          approval,
          facts.ownerUserId,
          await store.actorFacts(actorId),
          steering,
        )
      )
        return { allowed: true };
    }
    /*
     * REFUSED, AND ASKED FOR IN THE SAME BREATH. The proposal is the Bot's exposure now — what an
     * administrator would have to approve for this call, and every call like it, to go through.
     */
    const filed = await store.fileRequest({
      botId,
      serverId,
      reason: "refused_call",
      requestedBy: actorId,
      proposed: exposureOf(facts),
    });
    if (filed.created) {
      await recordAuditEvent(audit, {
        eventType: "shared_use.requested",
        targetType: "mcp_server",
        targetId: serverId,
        actorUserId: actorId,
        ...(initiator ? { initiator } : {}),
        payload: {
          bot: botId,
          server: serverId,
          reason: "refused_call",
          request: filed.id,
        },
      });
    }
    return { allowed: false, message };
  };
}
