import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
import { toolkitOf } from "./composio";
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

  /*
   * EVERY ROW AT AN APP'S CANONICAL URL, LOWEST ID FIRST — THE ANSWERING ROW IS THE HEAD. Several
   * `mcp_servers` rows may point at one `composio://<toolkit>` url (the url has no unique index,
   * deliberately), and the store's `brokeredAppRowsAt` names the row that answers for the app as
   * the first one SQL's `order by id` yields at that url. This is the same rule spelled with the
   * same `order by`, so the deployment's collation decides here exactly as it decides there — a
   * JavaScript sort would be UTF-16 order and could name a different row. It is restated rather
   * than imported because the store's helper is a closure inside `createStore`, and this store is
   * built from the database alone.
   *
   * "AT THE URL" MEANS THE CANONICAL ONE, `composio://${toolkitOf(url)}`, NOT THE DIALLED ROW'S OWN
   * url string. `toolkitOf` (`./composio`) trims whitespace and a trailing slash before it reads
   * the slug, so a row stored as `composio://github/` or `composio://github ` names the toolkit
   * `github` exactly as `composio://github` does — and the store's own gate (`brokeredAppRow`,
   * `accountRefFor`) only ever looks rows up at the trimmed, canonical address. Grouping by the raw
   * stored url instead, as this used to, made such a row an app of its own: an approval granted or
   * read through it could never be found by the gate, which asks at the canonical url and nowhere
   * else. So THIS is "the same rule" the comment above claims — same `order by`, same address the
   * gate itself resolves to.
   *
   * A row whose url is not `composio://` at all, or whose slug `toolkitOf` cannot parse, is an app
   * of its own and is the only row in its answer — the same two cases the store's own gate lets
   * stand rather than refuses (`accountRefFor` reads `toolkitOf` only for a `composio` provenance,
   * and a null result there is read as "not brokered", not as a refusal).
   *
   * NO ROW AT THE CANONICAL URL is answered by falling back to the dialled `serverId` itself, which
   * mirrors what the gate does with the same shape: a row dialled through a non-canonical url with
   * no row at the canonical one is refused by `accountRefFor` before any approval would be
   * consulted, so there is no answering row left to disagree with here either.
   *
   * THE DIALLED ROW'S OWN ID ALWAYS APPEARS IN `ids`, even when its stored url is not the canonical
   * one and so it is not among the siblings selected at that url — so `deleteApprovalsFor` and
   * `botsHolding`, both built on this, also cover the row that was actually dialled.
   *
   * An id with no row answers with itself, so a stale id reads as an app nobody holds and every
   * gate behind it stays shut.
   */
  async function rowsOfApp(
    serverId: string,
  ): Promise<{ appId: string; url: string | null; ids: string[] }> {
    const [row] = await database
      .select({ url: mcpServers.url })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    const url = row?.url ?? null;
    const toolkit = url ? toolkitOf(url) : null;
    if (!toolkit) return { appId: serverId, url, ids: [serverId] };
    const canonical = `composio://${toolkit}`;
    const siblings = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.url, canonical))
      .orderBy(asc(mcpServers.id));
    const ids = siblings.map((sibling) => sibling.id);
    if (!ids.includes(serverId)) ids.push(serverId);
    return { appId: siblings[0]?.id ?? serverId, url, ids };
  }

  /*
   * AN APPROVAL IS A FACT ABOUT THE ONE SHARED ACCOUNT AN APP HAS, NOT ABOUT WHICHEVER ROW A GRANT
   * HAPPENED TO BE MADE THROUGH. The callTool gate asks with the answering row's id; a grant made
   * through a duplicate row at the same url would otherwise write its approval under the
   * duplicate's id, where the gate never looks — and the reverse, an approval read under one id
   * and written under another, is how two rows' worth of audience could quietly diverge. So every
   * read and write of an approval or a request goes through this first, and callers may hand in
   * either id and land on the same key.
   */
  async function appIdOf(serverId: string): Promise<string> {
    return (await rowsOfApp(serverId)).appId;
  }

  async function approvalFor(
    botId: string,
    anyServerId: string,
  ): Promise<SharedUseApproval | null> {
    const serverId = await appIdOf(anyServerId);
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
    const serverId = await appIdOf(input.serverId);
    await database.transaction(async (tx) => {
      await tx
        .insert(sharedUseApprovals)
        .values({
          agentId: input.botId,
          serverId,
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
            eq(sharedUseApprovalMembers.serverId, serverId),
          ),
        );
      if (
        input.approval.audience === "people" &&
        input.approval.members.length > 0
      ) {
        await tx.insert(sharedUseApprovalMembers).values(
          input.approval.members.map((member) => ({
            agentId: input.botId,
            serverId,
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
            eq(sharedUseRequests.serverId, serverId),
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

  /*
   * EVERY ROW AT THE APP, NOT ONLY THE ANSWERING ONE. Approvals are keyed by the answering id now,
   * but one written under a duplicate's id before that rule existed is still an approval of this
   * account, and a mode switch that left it behind would hand it back the moment the duplicate
   * became the answering row. Clearing the whole url is the only reading of "end every approval
   * for this account" that has no such leftover.
   */
  async function deleteApprovalsFor(serverId: string) {
    const { ids } = await rowsOfApp(serverId);
    await database
      .delete(sharedUseApprovals)
      .where(inArray(sharedUseApprovals.serverId, ids));
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

  async function botForResponsibility(
    responsibilityId: string,
  ): Promise<string | null> {
    const [goal] = await database
      .select({ agentId: responsibilities.agentId })
      .from(responsibilities)
      .where(eq(responsibilities.id, responsibilityId))
      .limit(1);
    return goal?.agentId ?? null;
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

  /*
   * THE APPS, NOT THE ROWS. A grant names the row it was made through; the account it spends is
   * the app's, and whether that account is Shared is the ANSWERING row's `account_mode` — a
   * duplicate's column is a leftover nobody reads. So each granted row is walked to its url, the
   * url to its answering row, and the mode, the title and the id returned are that row's. A Bot
   * holding tools through two rows at one url holds one app and is listed once.
   *
   * "ITS URL" IS THE CANONICAL ONE A GRANTED ROW RESOLVES TO THROUGH `toolkitOf`, same as
   * `rowsOfApp` above, and not the row's own stored url compared by prefix. A granted row stored as
   * `composio://github/` is the toolkit `github` exactly as `composio://github` is, and grouping it
   * by its raw url instead left it unmatched against the answering row at the trimmed address — so
   * a Bot holding the app only through such a row was listed under a row of its own, or dropped,
   * rather than under the one row the gate actually answers for the app.
   */
  async function sharedAppsHeldBy(
    botId: string,
  ): Promise<{ serverId: string; title: string }[]> {
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
    const granted = await database
      .select({ id: mcpServers.id, url: mcpServers.url })
      .from(mcpServers)
      .where(inArray(mcpServers.id, serverIds));
    const toolkitOfRow = (url: string | null) => (url ? toolkitOf(url) : null);
    const canonicalUrls = [
      ...new Set(
        granted
          .map((row) => toolkitOfRow(row.url))
          .filter((toolkit): toolkit is string => !!toolkit)
          .map((toolkit) => `composio://${toolkit}`),
      ),
    ];
    const atUrls =
      canonicalUrls.length === 0
        ? []
        : await database
            .select({ id: mcpServers.id, url: mcpServers.url })
            .from(mcpServers)
            .where(inArray(mcpServers.url, canonicalUrls))
            .orderBy(asc(mcpServers.id));
    const answeringAt = new Map<string, string>();
    for (const row of atUrls)
      if (row.url && !answeringAt.has(row.url))
        answeringAt.set(row.url, row.id);
    const appIds = [
      ...new Set(
        granted.map((row) => {
          const toolkit = toolkitOfRow(row.url);
          if (!toolkit) return row.id;
          return answeringAt.get(`composio://${toolkit}`) ?? row.id;
        }),
      ),
    ];
    return database
      .select({ serverId: mcpServers.id, title: mcpServers.title })
      .from(mcpServers)
      .where(
        and(
          inArray(mcpServers.id, appIds),
          eq(mcpServers.accountMode, "shared"),
        ),
      );
  }

  /*
   * EVERY BOT THAT CAN SPEND THE APP'S ACCOUNT, THROUGH ANY ROW AT ITS URL. The server part of a
   * grant ref is compared whole with `split_part`, never as a `LIKE '<id>/%'` prefix: an id is free
   * to contain `_` and `%`, which a LIKE would read as wildcards and match a neighbouring app's
   * grants by.
   *
   * "ANY ROW AT ITS URL" HAS TO MEAN EVERY ROW `toolkitOf` RESOLVES TO THE SAME TOOLKIT, NOT ONLY
   * THE ONES `rowsOfApp` FOUND AT THE EXACT CANONICAL URL. `rowsOfApp`'s `ids` already covers the
   * canonical rows plus the row actually dialled, but a grant can be made through a THIRD row —
   * neither the dialled one nor stored at the trimmed address, e.g. `composio://<toolkit>/` sitting
   * elsewhere in the table — and that row never surfaces from an exact `eq` on the canonical url. So
   * every `composio://` row is read once here and matched in JavaScript by `toolkitOf`, which is the
   * one place that defines what "the same toolkit" means.
   */
  async function botsHolding(serverId: string): Promise<string[]> {
    const { ids, url } = await rowsOfApp(serverId);
    const toolkit = url ? toolkitOf(url) : null;
    let allIds = ids;
    if (toolkit) {
      const composioRows = await database
        .select({ id: mcpServers.id, url: mcpServers.url })
        .from(mcpServers)
        .where(sql`${mcpServers.url} like 'composio://%'`);
      const matching = composioRows
        .filter((row) => row.url && toolkitOf(row.url) === toolkit)
        .map((row) => row.id);
      allIds = [...new Set([...ids, ...matching])];
    }
    const rows = await database
      .selectDistinct({ agentId: pluginGrants.agentId })
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "mcp"),
          inArray(sql<string>`split_part(${pluginGrants.ref}, '/', 1)`, allIds),
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
    const serverId = await appIdOf(input.serverId);
    return database.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(sharedUseRequests)
        .where(
          and(
            eq(sharedUseRequests.agentId, input.botId),
            eq(sharedUseRequests.serverId, serverId),
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
        serverId,
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
    /*
     * THE CLAIM ABOVE PROVES THE REQUEST ROW IS THERE, and this read still has to be checked: `rows`
     * inner-joins the Bot's profile and the app, so a Bot or an app deleted between the claim and
     * this line drops the request out of the listing entirely. Returning it as though it were read
     * would hand back a decided request nobody can see; saying so names the one thing that happened.
     */
    if (!row) {
      throw new Error(
        `Shared-account request ${input.id} was ${input.decision}d, but its Bot or its app is no longer here to read it back.`,
      );
    }
    return row;
  }

  return {
    appIdOf,
    approvalFor,
    setApproval,
    deleteApprovalsFor,
    botFacts,
    actorFacts,
    sourcesOf,
    botForResponsibility,
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
