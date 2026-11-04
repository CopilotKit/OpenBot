import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AuditInitiator } from "../audit";
import { type AuditStore, recordAuditEvent } from "../audit";
import { createRoleRepository } from "../auth/guards";
import type { OpenBotRole } from "../auth/roles";
import type { Database } from "../db/client";
import { bots } from "../agents/bot-registry/directory";
import { botConfiguration } from "../configuration/directory";
import {
  responsibilities,
  responsibilityTriggers,
  sharedUseRequests,
  users,
} from "../db/schema";
import { type PolicyCache, policy } from "../policy/cache";
import { PolicyVersionConflictError } from "../policy/client";
import type { ConnectionApprovalRecord } from "../policy/types";
import { BROKERED_PROFILE, type BrokerProvider, toolkitOfFor } from "./access";
import {
  allServers,
  findServer,
  peekServer,
  serversAt,
} from "./plugin-store/records";
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

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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
}) => Promise<
  | { allowed: true }
  | {
      allowed: false;
      message: string;
      /** Why, for the audit row: the audience reaches too far, or the run's steering is unknown. */
      refusal?: "shared_audience" | "shared_steering";
    }
>;

const sameApproval = (left: SharedUseApproval, right: SharedUseApproval) =>
  covers(left, right) && covers(right, left);

/**
 * The url scheme a broker's apps live at, read from the one record that holds it.
 *
 * DERIVED HERE AS `${provider}://` UNTIL {@link BROKERED_PROFILE} BECAME REACHABLE. That derivation
 * was right about every scheme there is and still a second source of truth: the store mints its rows
 * from the record, this read them back from a rule, and nothing held the two in step beyond the
 * happy fact that a broker's scheme is its own name. A third broker that spelled its scheme any
 * other way would have had its rows written at one address and looked for at another, silently, in
 * the gate that decides who may use a shared account. One table, one spelling.
 */
const schemeOf = (provider: BrokerProvider) =>
  BROKERED_PROFILE[provider].scheme;

/**
 * `provider` IS REQUIRED, with no default, for the reason `PluginStoreOptions.brokerProvider` is:
 * this store has to read urls with the same parser, at the same scheme, as the store whose gate
 * consults the approvals filed here. A default would let the two disagree silently, which is the
 * failed-open shape the canonical-url rule below exists to prevent. The caller passes the one value
 * the plugin store is given.
 */
export function createSharedUseStore(
  database: Database,
  provider: BrokerProvider,
  /**
   * The policy this store reads and writes approvals through: the process's (`policy()`), unless a
   * test hands it another server's, to show what one server that has not heard of a change does.
   */
  held?: PolicyCache,
) {
  const cache = () => held ?? policy();
  const roles = createRoleRepository(database);
  const scheme = schemeOf(provider);
  const appOfUrl = (url: string) => toolkitOfFor(provider, url);
  const canonicalUrlOf = (toolkit: string) => `${scheme}${toolkit}`;

  /*
   * EVERY ROW AT AN APP'S CANONICAL URL, LOWEST ID FIRST — THE ANSWERING ROW IS THE HEAD. Several
   * `mcp_servers` rows may point at one `<scheme><toolkit>` url (the url has no unique index,
   * deliberately), and the store's `brokeredAppRowsAt` names the row that answers for the app as
   * the first one SQL's `order by id` yields at that url. This is the same rule spelled with the
   * same `order by`, so the deployment's collation decides here exactly as it decides there — a
   * JavaScript sort would be UTF-16 order and could name a different row. It is restated rather
   * than imported because the store's helper is a closure inside `createStore`, and this store is
   * built from the database alone.
   *
   * "AT THE URL" MEANS THE CANONICAL ONE, `${scheme}${appOfUrl(url)}`, NOT THE DIALLED ROW'S OWN
   * url string. `appOfUrl` (the active provider's own parser, via `toolkitOfFor`) trims whitespace and a trailing slash before it reads
   * the slug, so a row stored as `<scheme>github/` or `<scheme>github ` names the toolkit
   * `github` exactly as `<scheme>github` does — and the store's own gate (`brokeredAppRow`,
   * `accountRefFor`) only ever looks rows up at the trimmed, canonical address. Grouping by the raw
   * stored url instead, as this used to, made such a row an app of its own: an approval granted or
   * read through it could never be found by the gate, which asks at the canonical url and nowhere
   * else. So THIS is "the same rule" the comment above claims — same `order by`, same address the
   * gate itself resolves to.
   *
   * A row whose url is not at the provider's scheme at all, or whose slug `appOfUrl` cannot parse, is an app
   * of its own and is the only row in its answer — the same two cases the store's own gate lets
   * stand rather than refuses (`accountRefFor` reads `appOfUrl` only for a row provenanced at the active provider,
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
    /** Unused: the apps are read from memory, which is safe inside any caller's transaction. */
    _executor: Database | Transaction = database,
  ): Promise<{ appId: string; url: string | null; ids: string[] }> {
    const row = peekServer(serverId);
    const url = row?.url ?? null;
    const toolkit = url ? appOfUrl(url) : null;
    if (!toolkit) return { appId: serverId, url, ids: [serverId] };
    const canonical = canonicalUrlOf(toolkit);
    const siblings = serversAt([canonical]);
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
  async function appIdOf(
    serverId: string,
    executor: Database | Transaction = database,
  ): Promise<string> {
    return (await rowsOfApp(serverId, executor)).appId;
  }

  /**
   * The approval for this Bot at the app, whoever set it, and whether it may be read now.
   *
   * The approval is Intelligence's (organization policy), read from memory: this is on the path of
   * every call that spends a Shared app's account. Whether owners decide is the app's own, from memory.
   */
  async function storedApproval(botId: string, serverId: string) {
    const approval = cache().connectionApproval({
      agentId: botId,
      connectionId: serverId,
    });
    if (!approval) return null;
    // The app's own two fields, from memory: an app that is gone leaves owners deciding nothing.
    const app = peekServer(serverId);
    return {
      audience: approval.audience,
      outsideInput: approval.outsideInput,
      approvedAs: approval.approvedAs,
      members: approval.members,
      version: approval.version,
      ownersDecide: app?.ownerGrants === "any" && app.accountMode === "shared",
    };
  }

  /**
   * Who set the audience this Bot holds at the app — `admin` (a null from an older replica is
   * one), `owner`, or null where there is none.
   */
  async function approvalSource(
    botId: string,
    anyServerId: string,
  ): Promise<"admin" | "owner" | null> {
    const row = await storedApproval(botId, await appIdOf(anyServerId));
    if (!row) return null;
    return row.approvedAs === "owner" ? "owner" : "admin";
  }

  /*
   * AN OWNER'S AUDIENCE COUNTS ONLY WHILE OWNERS DECIDE. One set by an owner's grant is withdrawn
   * when an administrator stops letting owners give the app, but a row that outlived that — a
   * replica that switched the rule without withdrawing, a delete that failed — must not keep the
   * team account open. So it is read as no approval unless the app's rule is `any` now.
   */
  async function approvalFor(
    botId: string,
    anyServerId: string,
  ): Promise<SharedUseApproval | null> {
    const serverId = await appIdOf(anyServerId);
    const row = await storedApproval(botId, serverId);
    if (!row) return null;
    if (row.approvedAs === "owner" && !row.ownersDecide) return null;
    return {
      audience: row.audience,
      outsideInput: row.outsideInput,
      members: row.members.map((member) => ({ ...member })) as ApprovalMember[],
    };
  }

  type ApprovalInput = {
    botId: string;
    serverId: string;
    approval: SharedUseApproval;
    by: string;
    /** Who is setting it. Only {@link approveOwnerGrant} says `owner`. */
    as?: "admin" | "owner";
  };

  async function setApproval(input: ApprovalInput) {
    const serverId = await appIdOf(input.serverId);
    await writeApproval({ ...input, serverId });
  }

  /**
   * Store the approval in Intelligence, then close what it answers here.
   *
   * THE GUARANTEES THE OLD ADVISORY LOCK GAVE, KEPT WITHOUT IT. The approval and its members are one
   * record in Intelligence, written in one request, so no reader ever sees half of a write. An owner's
   * approval is stored only where none is (`If-None-Match: *`), so it never replaces one an
   * administrator just stored; an administrator's replaces whatever is there, as the upsert did. Only
   * then are the pending requests it answers closed, in a transaction of their own here: nothing here
   * waits on Intelligence with a transaction open.
   *
   * False when an owner's approval found one already there.
   */
  async function writeApproval(
    input: ApprovalInput & {
      /**
       * For an administrator's decision on a request: the approval stored when the decision began
       * (null: none). The decision is written over that and nothing newer, so an approval another
       * administrator stores while it waits stands, as it did when the two were serialized by a lock
       * and the later one won. An owner's approval stored meanwhile is still replaced: an
       * administrator's approval over it makes it theirs.
       */
      over?: ConnectionApprovalRecord | null;
    },
  ): Promise<boolean> {
    const serverId = input.serverId;
    const approvedAs = input.as ?? "admin";
    const key = { agentId: input.botId, connectionId: serverId };
    const draft = {
      audience: input.approval.audience,
      outsideInput: input.approval.outsideInput,
      members:
        input.approval.audience === "people"
          ? dedupeMembers(input.approval.members)
          : [],
      approvedBy: input.by,
      approvedAs,
    };
    if (approvedAs === "owner") {
      try {
        await cache().putConnectionApproval(key, draft, { ifNoneMatch: true });
      } catch (error) {
        if (error instanceof PolicyVersionConflictError) return false;
        throw error;
      }
    } else if (input.over === undefined) {
      await cache().putConnectionApproval(key, draft);
    } else {
      let over = input.over;
      for (let attempt = 1; ; attempt++) {
        try {
          await cache().putConnectionApproval(
            key,
            draft,
            over ? { ifMatch: over.version } : { ifNoneMatch: true },
          );
          break;
        } catch (error) {
          if (!(error instanceof PolicyVersionConflictError) || attempt >= 3)
            throw error;
          const current = await cache().refreshConnectionApproval(key);
          if (current?.approvedAs === "admin") return false;
          over = current;
        }
      }
    }
    await closeAnsweredRequests(
      input.botId,
      serverId,
      input.approval,
      input.by,
    );
    return true;
  }

  /* A pending request this approval now answers is closed as approved, so the inbox never asks twice. */
  async function closeAnsweredRequests(
    botId: string,
    serverId: string,
    approval: SharedUseApproval,
    by: string,
  ) {
    const pending = await database
      .select()
      .from(sharedUseRequests)
      .where(
        and(
          eq(sharedUseRequests.agentId, botId),
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
      if (covers(approval, proposed)) {
        await database
          .update(sharedUseRequests)
          .set({
            status: "approved",
            decidedBy: by,
            decidedAt: new Date(),
          })
          .where(
            and(
              eq(sharedUseRequests.id, request.id),
              eq(sharedUseRequests.status, "pending"),
            ),
          );
      }
    }
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
    await deleteApprovalsAt(ids);
  }

  /**
   * A Bot's owner gave it a Shared app whose rule lets owners decide: the audience that grant sets,
   * written and answered, or null where it sets none.
   *
   * WHO, EXACTLY THE PEOPLE WHO CAN USE THE BOT NOW. The Bot's exposure as it stands — its owner
   * for a private Bot, its published audience for a Team Bot — and never outside input: an email
   * or a webhook steering the team account is not somebody who can use the Bot, and stays an
   * administrator's to approve. It is a snapshot, as an administrator's approval is: publishing the
   * Bot further later is caught by the gate and asked of an administrator, the way every widening is.
   *
   * NEVER OVER AN APPROVAL ALREADY THERE. An administrator's stands for a reason the owner did not
   * give, narrower or wider, and the owner's own from before is already this. Nothing is written
   * unless the app's answering row is Shared and its rule is `any` now, read here rather than
   * trusted from the caller.
   */
  async function approveOwnerGrant(input: {
    botId: string;
    serverId: string;
    by: string;
  }): Promise<SharedUseApproval | null> {
    const serverId = await appIdOf(input.serverId);
    const app = await findServer(serverId);
    if (app?.accountMode !== "shared" || app.ownerGrants !== "any") return null;
    if (await storedApproval(input.botId, serverId)) return null;
    const approval: SharedUseApproval = {
      ...exposureOf(await botFacts(input.botId)),
      outsideInput: false,
    };
    const written = await writeApproval({
      botId: input.botId,
      serverId,
      approval,
      by: input.by,
      as: "owner",
    });
    return written ? approval : null;
  }

  /**
   * Withdraw the audiences owners' grants set at an app — for one Bot, or every Bot — and none an
   * administrator set. Answers the Bots withdrawn from, so each can be written to the trail.
   */
  async function withdrawOwnerApprovals(input: {
    serverId: string;
    botId?: string;
  }): Promise<string[]> {
    const { ids } = await rowsOfApp(input.serverId);
    const withdrawn = new Set<string>();
    for (const connectionId of ids) {
      // From Intelligence, not memory: an administrator's change must not miss an owner's approval
      // another server stored a moment ago.
      const held = await cache().readConnectionApprovals({
        connectionId,
        approvedAs: "owner",
      });
      for (const approval of held) {
        if (input.botId && approval.agentId !== input.botId) continue;
        if (await withdrawOwnerApproval(approval))
          withdrawn.add(approval.agentId);
      }
    }
    return [...withdrawn];
  }

  /**
   * Remove one owner's approval, and only while it is still an owner's: the delete names the version
   * read, so an administrator's approval stored over it in between is never removed. That was the
   * `approved_as = 'owner'` in the old single delete.
   */
  async function withdrawOwnerApproval(
    approval: ConnectionApprovalRecord,
  ): Promise<boolean> {
    let current: ConnectionApprovalRecord | null = approval;
    for (
      let attempt = 0;
      attempt < 3 && current?.approvedAs === "owner";
      attempt++
    ) {
      try {
        return await cache().deleteConnectionApproval(
          { agentId: current.agentId, connectionId: current.connectionId },
          { ifMatch: current.version },
        );
      } catch (error) {
        if (!(error instanceof PolicyVersionConflictError)) throw error;
        current = await cache().refreshConnectionApproval(current);
      }
    }
    return false;
  }

  /** Every approval at these app rows, whoever set it. From Intelligence, so none is missed. */
  async function deleteApprovalsAt(connectionIds: readonly string[]) {
    for (const connectionId of connectionIds) {
      for (const approval of await cache().readConnectionApprovals({
        connectionId,
      }))
        await cache().deleteConnectionApproval(approval);
    }
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
    const profile = await bots().find(botId);
    // Its publication, audience and assignments: the Bot's access, as this instance holds it.
    const access = botConfiguration().accessOf(botId);
    const published = access.publication;
    const listed =
      published?.audience === "people"
        ? published.members.map((member) => ({
            kind: member.kind,
            value: member.value,
          }))
        : [];
    const assigned = access.assignments.map((assignment) => ({
      group: assignment.group,
    }));
    const goals = await database
      .select({ id: responsibilities.id })
      .from(responsibilities)
      .where(eq(responsibilities.agentId, botId));
    const sources = (
      await Promise.all(goals.map((goal) => sourcesOf(goal.id)))
    ).flat();
    return {
      /* A Bot Intelligence does not have is treated as a package Bot: public and ownerless. */
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
   * "ITS URL" IS THE CANONICAL ONE A GRANTED ROW RESOLVES TO THROUGH `appOfUrl`, same as
   * `rowsOfApp` above, and not the row's own stored url compared by prefix. A granted row stored as
   * `<scheme>github/` is the toolkit `github` exactly as `<scheme>github` is, and grouping it
   * by its raw url instead left it unmatched against the answering row at the trimmed address — so
   * a Bot holding the app only through such a row was listed under a row of its own, or dropped,
   * rather than under the one row the gate actually answers for the app.
   */
  async function sharedAppsHeldBy(
    botId: string,
  ): Promise<{ serverId: string; title: string }[]> {
    const grants = botConfiguration()
      .accessOf(botId)
      .grants.filter((grant) => grant.kind === "mcp");
    const serverIds = [
      ...new Set(grants.map((grant) => grant.ref.split("/")[0] ?? "")),
    ].filter(Boolean);
    if (serverIds.length === 0) return [];
    const wanted = new Set(serverIds);
    const granted = allServers().filter((row) => wanted.has(row.id));
    const toolkitOfRow = (url: string | null) => (url ? appOfUrl(url) : null);
    const canonicalUrls = [
      ...new Set(
        granted
          .map((row) => toolkitOfRow(row.url))
          .filter((toolkit): toolkit is string => !!toolkit)
          .map(canonicalUrlOf),
      ),
    ];
    const atUrls = serversAt(canonicalUrls);
    const answeringAt = new Map<string, string>();
    for (const row of atUrls)
      if (row.url && !answeringAt.has(row.url))
        answeringAt.set(row.url, row.id);
    const appIds = [
      ...new Set(
        granted.map((row) => {
          const toolkit = toolkitOfRow(row.url);
          if (!toolkit) return row.id;
          return answeringAt.get(canonicalUrlOf(toolkit)) ?? row.id;
        }),
      ),
    ];
    const apps = new Set(appIds);
    return allServers()
      .filter((row) => apps.has(row.id) && row.accountMode === "shared")
      .map((row) => ({ serverId: row.id, title: row.title }));
  }

  /*
   * EVERY BOT THAT CAN SPEND THE APP'S ACCOUNT, THROUGH ANY ROW AT ITS URL. The server part of a
   * grant ref is compared whole with `split_part`, never as a `LIKE '<id>/%'` prefix: an id is free
   * to contain `_` and `%`, which a LIKE would read as wildcards and match a neighbouring app's
   * grants by.
   *
   * "ANY ROW AT ITS URL" HAS TO MEAN EVERY ROW `appOfUrl` RESOLVES TO THE SAME TOOLKIT, NOT ONLY
   * THE ONES `rowsOfApp` FOUND AT THE EXACT CANONICAL URL. `rowsOfApp`'s `ids` already covers the
   * canonical rows plus the row actually dialled, but a grant can be made through a THIRD row —
   * neither the dialled one nor stored at the trimmed address, e.g. `<scheme><toolkit>/` sitting
   * elsewhere in the table — and that row never surfaces from an exact `eq` on the canonical url. So
   * every row at the provider's scheme is read once here and matched in JavaScript by `appOfUrl`, which is the
   * one place that defines what "the same toolkit" means.
   */
  async function botsHolding(serverId: string): Promise<string[]> {
    const { ids, url } = await rowsOfApp(serverId);
    const toolkit = url ? appOfUrl(url) : null;
    let allIds = ids;
    if (toolkit) {
      const schemeRows = allServers().filter((row) =>
        row.url.startsWith(scheme),
      );
      const matching = schemeRows
        .filter((row) => row.url && appOfUrl(row.url) === toolkit)
        .map((row) => row.id);
      allIds = [...new Set([...ids, ...matching])];
    }
    const servers = new Set(allIds);
    return botConfiguration()
      .access.all()
      .filter((access) =>
        access.grants.some(
          (grant) =>
            grant.kind === "mcp" && servers.has(grant.ref.split("/")[0] ?? ""),
        ),
      )
      .map((access) => access.botId);
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
    // A request whose app is gone is left out, as the join to the app's row left it out.
    const selected = (
      await database
        .select({ request: sharedUseRequests })
        .from(sharedUseRequests)
        .where(where)
        .orderBy(sql`${sharedUseRequests.createdAt} desc`)
    ).flatMap((row) => {
      const app = peekServer(row.request.serverId);
      return app ? [{ ...row, title: app.title }] : [];
    });
    // A request whose Bot Intelligence no longer has is left out, as the join to `agents` left it out.
    const known = await bots().findMany(
      selected.map((row) => row.request.agentId),
    );
    const found = selected.flatMap((row) => {
      const bot = known.get(row.request.agentId);
      return bot
        ? [{ ...row, botName: bot.name, ownerUserId: bot.ownerUserId }]
        : [];
    });
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
    /*
     * CLAIMED HERE FIRST, THEN APPROVED IN INTELLIGENCE. The claim is one conditional update, so of two
     * administrators deciding at once exactly one wins, as the lock made it. The approval it grants is
     * written after the claim commits, never inside it, and only over the approval that was stored
     * when the decision began; until it lands the gate refuses the account, which is the safe side. If
     * it cannot be written the claim is undone and the request is pending again, so the inbox still
     * asks rather than showing an approval nobody holds.
     */
    const [request] = await database
      .select({
        botId: sharedUseRequests.agentId,
        serverId: sharedUseRequests.serverId,
      })
      .from(sharedUseRequests)
      .where(
        and(
          eq(sharedUseRequests.id, input.id),
          eq(sharedUseRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (!request) throw new SharedUseRequestDecidedError();
    const serverId = await appIdOf(request.serverId);
    const over =
      cache().connectionApproval({
        agentId: request.botId,
        connectionId: serverId,
      }) ?? null;
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
      try {
        await writeApproval({
          botId: claimed.agentId,
          serverId,
          by: input.by,
          approval: {
            audience: claimed.proposedAudience,
            outsideInput: claimed.proposedOutsideInput,
            members: claimed.proposedMembers,
          },
          over,
        });
      } catch (error) {
        await database
          .update(sharedUseRequests)
          .set({ status: "pending", decidedBy: null, decidedAt: null })
          .where(
            and(
              eq(sharedUseRequests.id, input.id),
              eq(sharedUseRequests.status, "approved"),
              eq(sharedUseRequests.decidedBy, input.by),
            ),
          );
        throw error;
      }
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

  /**
   * Whether the gate would let this person's own chat with this Bot reach the app's team account —
   * the same approval, owner and audience test the gate makes for a person-started run, and nothing
   * it does after refusing. For a screen saying what a call would meet; the gate still decides
   * every call.
   */
  async function admitsPerson(input: {
    botId: string;
    serverId: string;
    actorId: string;
  }): Promise<boolean> {
    const approval = await approvalFor(input.botId, input.serverId);
    if (!approval) return false;
    const facts = await botFacts(input.botId);
    return admits(
      approval,
      facts.ownerUserId,
      await actorFacts(input.actorId),
      {
        outside: false,
      },
    );
  }

  return {
    appIdOf,
    deleteApprovalsAt,
    approvalFor,
    approvalSource,
    admitsPerson,
    setApproval,
    approveOwnerGrant,
    withdrawOwnerApprovals,
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
    const message = `This Bot reaches more people than an admin approved for the shared ${title} account. An admin has been asked to approve it.`;
    const steering = await steeringOf(initiator, store.sourcesOf);
    /*
     * A RUN WHOSE STEERING CANNOT BE TOLD IS REFUSED WITHOUT A REQUEST. No approval an administrator
     * could give would let it through — the question is who is behind the run, not how wide the
     * audience is — so filing one would only put a request in the inbox that cannot be answered.
     */
    if (steering.kind === "refuse") {
      return {
        allowed: false,
        refusal: "shared_steering",
        message: `The shared ${title} account was not used, because ${steering.why}.`,
      };
    }
    const facts = await store.botFacts(botId);
    const approval = await store.approvalFor(botId, serverId);
    if (approval) {
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

/** Membership is a set of exact (kind, value) pairs; a user and a group with the same value are distinct. */
function dedupeMembers(members: readonly ApprovalMember[]): ApprovalMember[] {
  const seen = new Set<string>();
  const unique: ApprovalMember[] = [];
  for (const member of members) {
    const id = `${member.kind}\u0000${member.value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push({ kind: member.kind, value: member.value });
  }
  return unique;
}
