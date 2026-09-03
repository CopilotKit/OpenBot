import { and, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { Database } from "./db/client";
import { auditEvents } from "./db/schema";

const sensitiveKeys = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "clientsecret",
  "content",
  "credential",
  "credentials",
  "document_content",
  "documentcontent",
  "encrypted_value",
  "encryptedvalue",
  "id_token",
  "idtoken",
  "password",
  "prompt",
  "refresh_token",
  "refreshtoken",
  "result",
  "secret",
  "secrets",
  "token",
  "tokens",
  "tool_arguments",
  "toolarguments",
  "tool_result",
  "toolresult",
]);

export const auditEventTypes = [
  "configuration.changed",
  "credential.created",
  "credential.rotated",
  /**
   * A rotation the vault refused, and why.
   *
   * Recorded because the refusals are the interesting ones. A rotation aimed at a key other than the
   * one the credential belongs to, or at a credential already revoked, is either a caller with a bug
   * or somebody trying to retire a key they were not asked to retire, and neither left a trace while
   * only the successes were written.
   */
  "credential.rotation_refused",
  "credential.revoked",
  "connector.sync_succeeded",
  "connector.sync_failed",
  "knowledge.searched",
  /**
   * Which coworker an untagged message was routed to, and why.
   *
   * A channel is pinned to one coworker before its first turn, so when the person did not name one
   * with `@`, something chooses. This is that choice, made visible: the row names the coworker it
   * went to, whether it was an inferred match or the default it fell back to, and the coworkers it
   * chose between. The message itself is not here (the payload redaction drops it either way) — a
   * routing decision is a fact about where a conversation went, not a copy of what was said.
   */
  "channel.routed",
  /**
   * A channel was removed from every member's roster, and by whom.
   *
   * The removal is soft, so the row and its thread survive and `channels.deleted_at` records that it
   * happened. What it cannot record is who did it: a timestamp answers "when did that conversation
   * disappear" and not "who ended it for everybody in it", which is the half somebody asks about.
   * `payload.mechanism` names how, so a later hard delete is distinguishable from this one.
   */
  "channel.deleted",
  "agent.invoked",
  /**
   * An address this deployment declined to dial for a Bot, and why.
   *
   * The stored endpoint is re-checked on the way out of every run, and so is each address it
   * redirects to. When one of those is refused the run fails and the person sees why, which is the
   * whole of what anybody learns without this row.
   *
   * That is the wrong shape for the thing worth knowing. A registration is one person at one moment;
   * a stored agent quietly beginning to redirect somewhere it should not is a fact about an endpoint,
   * happening on every run, with nobody watching. It reads as an agent being flaky until somebody can
   * count it. The row names the address and the reason, so a reader can tell an agent that moved from
   * one aimed at the metadata endpoint.
   */
  "agent.dial_refused",
  /**
   * A Bot's stream stopped producing anything and the turn was ended for it.
   *
   * Recorded because a Bot is somebody else's infrastructure and this is the failure it has that
   * nothing else in the trail can show. Every other row here is something that happened; this one is
   * the absence of anything happening, which leaves no trace of its own.
   *
   * It is also the sort of thing nobody notices is happening repeatedly. One hung turn reads as a
   * bad afternoon and gets a shrug; the same Bot hanging twice a day for a month is a fact about an
   * endpoint, and it only becomes visible when somebody can count it. The row names the Bot, how
   * long its stream was silent, and how many chunks it managed first, so a reader can tell an
   * endpoint that dies mid-answer from one that never answers at all.
   */
  "agent.stream_stalled",
  /*
   * Which of a Bot's tools were put in front of the model for one run, and why those.
   *
   * Discovery, recorded as its own fact, because a run is now offered a subset of what the Bot holds
   * and every other row here answers a question about a call that happened. This one answers "why
   * did it call that", and its harder twin, "why did it not call anything" — a Bot that had the
   * right tool granted, was not offered it, and answered from memory leaves no other trace at all.
   * Without this row that failure is indistinguishable from a model that simply chose badly.
   *
   * DISCOVERY IS NOT PERMISSION, and the row is not an authorization record. Everything named here
   * was already granted; being offered is what changed. A tool still goes through the grant, the
   * policy and `mcp.call_succeeded` or `mcp.call_rejected` before anything happens, so this row
   * never appears in place of one of those, only before it.
   *
   * `reason` is the part worth reading. It separates a deployment that narrowed from one that never
   * declared anything and one whose selector was unreachable, which look identical from outside.
   */
  "mcp.tools_discovered",
  "mcp.call_succeeded",
  "mcp.call_rejected",
  /*
   * A call this deployment permitted and the vendor did not complete.
   *
   * The third outcome, and the one the trail was missing. `call_rejected` is this deployment
   * declining; `call_succeeded` is a vendor answering. Between them sits a call that passed every
   * check here and then failed out there — a credential the vendor would not take, an API not
   * enabled, a timeout — and without a row of its own it was invisible.
   *
   * Worse than invisible. `call_succeeded` used to be written before the network call rather than
   * after, so a call that died at the vendor left a row saying it had succeeded, and the Admin page
   * agreed. That is the one shape of audit bug worth going out of the way to avoid: a trail that is
   * confidently wrong is more dangerous than one that is silent, because it is used to rule things
   * out.
   */
  "mcp.call_failed",
  /*
   * Something presenting itself as a Bot asked to spend a grant and was turned away at the door.
   *
   * The fourth outcome, and the only one that used to leave nothing behind. The three above are all
   * written inside `callTool`, which is reached only after the caller has proved which Bot it is.
   * A caller that fails THAT check never reaches `callTool`, so a refused callback was invisible:
   * no row, no log, nothing to count.
   *
   * Which made the most confusing failure in the product completely silent. A Bot holding a stale
   * token — the deployment's secret rotated, a container not recreated with it — has every call
   * rejected at this line, returns nothing to its own model, and the model tells the person "no
   * files were found". A false negative, delivered as an answer, about a Drive that has the files.
   * Every place a person would look to check agreed that nothing had happened.
   *
   * It is a security row as much as a diagnostic one. This endpoint is how a Bot spends grants, and
   * an unauthenticated caller probing it generated no evidence at all.
   *
   * The row deliberately does NOT name a Bot or an actor. Both arrive in the credential that just
   * failed to verify, so writing them down would be recording an unproven claim in the one place
   * that is supposed to be believed. What is recorded is what is known: that a call was attempted,
   * which tool it named, and why it was refused.
   */
  "mcp.callback_refused",
  /*
   * An administrator registered this deployment's OAuth client with a vendor.
   *
   * Recorded because it decides what every subsequent consent screen belongs to. If a client is
   * replaced, every person who connects afterwards is granting access to a different registration,
   * and the row is what lets somebody reading the trail line a connection up against the client that
   * was current when it was made. The client id, never the secret.
   */
  "mcp.oauth_client_registered",
  /*
   * One person connected their own account to one server.
   *
   * Its own row rather than a credential event, because what happened is not "a secret was stored" —
   * it is a person granting a deployment continuing access to their documents, which is the kind of
   * thing they are entitled to see a record of. Carries the scope the vendor actually granted.
   */
  "mcp.account_connected",
  /*
   * One person's connector access retired, by them or on their behalf.
   *
   * The counterpart to the row above, and the one an auditor reaches for when asked "what happened to
   * their access". `reason` distinguishes somebody disconnecting their own account from an
   * administrator removing them, because those are the same effect and very different events.
   *
   * `vendorRevoked` says whether the grant at the vendor was withdrawn as well, and is currently
   * false: removing somebody stops this deployment holding a usable secret, and the grant at Google
   * outlives it until it is revoked there. Recorded rather than glossed, because a row that implied
   * otherwise would be worse than no row.
   */
  "mcp.account_disconnected",
  // Every action a Bot takes on its computer, allowed or refused. Both, always: a trail that records
  // only what was permitted cannot answer whether the Bot tried.
  "computer.action_allowed",
  "computer.action_refused",
  // Permitted by policy, attempted, and did not succeed. Its own type because "allowed" reads as
  // "happened", and a trail that cannot tell those apart misleads exactly when it matters most.
  "computer.action_failed",
  // A person taking the wheel and giving it back. Recorded as a period rather than as keystrokes: the
  // useful fact for an investigator is that a human drove this browser between these two times, and
  // logging every click a person made would bury it while telling nobody anything.
  "computer.help_requested",
  "computer.control_taken",
  "computer.control_released",
  // A credential a person entered by hand. The row records that it happened, what it was called and
  // which field it went in; the value is on a path this trail is not on.
  "computer.secret_requested",
  "computer.secret_supplied",
  // The computer itself being stopped or wiped. `reset` destroys every login the Bot had, which is
  // both the recovery path and the most consequential button on the admin page, so who pressed it and
  // when is exactly the sort of thing an investigator needs and nothing else records.
  "computer.stopped",
  "computer.reset",
  /**
   * The boundary this deployment booted with.
   *
   * The live policy is held in memory, so a restart returns to the configured default unless the
   * saved row is loaded again. This boot event records the boundary that is actually in force, so an
   * audit reader can interpret earlier policy changes against the deployment state that followed.
   *
   * Written on every boot rather than only when something was lost, because the trail cannot know
   * what the previous process had, and "the deployment restarted with this boundary" is the fact that
   * matters either way.
   */
  "computer.policy_loaded",
  /**
   * Whether this deployment gives each Bot a computer of its own, said out loud at boot.
   *
   * Without a supervisor every Bot shares one browser, which is a legitimate way to run on a laptop
   * and the opposite of what per-Bot isolation promises. The difference is invisible: the screens look
   * identical, the trail looks identical, and a Bot acting on another Bot's session looks exactly like
   * a Bot acting on its own. Nothing in the product distinguishes them, so nothing would.
   *
   * So the deployment states which one it is, once, where it cannot be argued with later. Same reason
   * as `computer.policy_loaded`: the trail records the boundary that is actually in force.
   */
  "computer.isolation_loaded",
  /**
   * The Bot declined something it was asked to do.
   *
   * Every event above records an action a Bot took, decided on by the gateway. A model that refuses
   * before calling any tool takes no action, so the gateway never sees it. This event is the audit
   * trail's record that the Bot was asked to do something and declined before acting.
   *
   * For governance, "this Bot was probed six times last week" is a question the trail answers, and a
   * refusal is the evidence of the attempt.
   *
   * Self-reported. The Bot calls this because it was told to, so a model
   * that declines and says nothing still writes nothing. It records more than zero, which is what
   * there was, and it is not a control, nothing here is enforced by it.
   */
  "bot.declined",

  /*
   * What a Bot may answer with, decided per Bot and recorded like anything else it is trusted with.
   *
   * A component is a capability you grant, so the trail has to answer the same questions a connector
   * or a skill does: who gave this Bot this, when, and who took it away again. Publishing is here for
   * the same reason, it changes what every Bot in the deployment is offered at once, which is the
   * largest single change anybody can make on this surface.
   *
   * `component.refused` records a Bot reaching for something it does not hold. Everything else is a decision somebody made
   * on purpose; this is a Bot reaching for something it does not hold. It is written by the same
   * decision point the app asks before every render, so a grant revoked mid-conversation leaves a row
   * rather than a component that quietly stops appearing.
   */
  "component.granted",
  "component.revoked",
  "component.published",
  "component.unpublished",
  "component.draft_saved",
  "component.refused",

  /*
   * A component reading real data, rather than being handed figures by a model.
   *
   * Recorded like any other tool call because that is what it is: something acting on this
   * deployment's data on a Bot's behalf. `reads` names the source in a few words, so a reader can see
   * what a component actually touched without opening it.
   *
   * `component.function_failed` is deliberately not a refusal. Nothing was forbidden, the read
   * broke, and filing a broken query as a policy event teaches a reader to distrust the policy
   * events that are real.
   */
  "component.function_granted",
  "component.function_revoked",
  "component.function_called",
  "component.function_refused",
  "component.function_failed",
  /*
   * Who may use this deployment, and at what level.
   *
   * On the trail rather than only in the table, because the table holds the current answer and this
   * is the only place that says who changed it and when. "Why does this person have admin" and "who
   * removed them" are questions a table of current state cannot answer at all.
   */
  "person.role_changed",
  "person.access_revoked",
  "person.access_restored",
  /*
   * Getting in, and being turned away.
   *
   * The trail had nothing about sign-in at all, which left two questions unanswerable. Anybody who
   * could edit `INITIAL_ADMIN_EMAILS` granted themselves the administrator role on their next
   * sign-in and no row anywhere said it had happened, because the floor is re-applied silently by
   * design. And revoking somebody deletes their sessions, which were the only record that they had
   * ever been here: after a revocation the deployment could not show that the person had signed in,
   * let alone when or how often.
   *
   * `session.refused` is the one somebody investigating actually reaches for. A revoked person still
   * holding a bookmark, or an address outside the deployment trying the front door, produces nothing
   * else anywhere.
   */
  "session.signed_in",
  "session.refused",
  "person.admin_by_configuration",
  /*
   * A company's own identity provider, added or taken away.
   *
   * Whoever holds this decides who can sign in at all, so the two ends of its life belong on the
   * trail next to the roles it hands out.
   */
  "identity_provider.registered",
  "identity_provider.removed",
  /*
   * What a Bot is and what it may reach.
   *
   * The trail recorded every mouse movement a Bot made and could not answer "who pointed this Bot at
   * that host, and when", which is the first question asked in an incident. A Bot's endpoint is
   * where conversation content is sent and its callback token is a capability handed to somebody
   * else's infrastructure, so the two ends of both belong here.
   *
   * `bot.updated` carries what changed rather than the new values: the endpoint is worth naming, and
   * a key never is.
   */
  "bot.created",
  "bot.updated",
  "bot.duplicated",
  "bot.hidden",
  "bot.unhidden",
  "bot.deleted",
  "bot.callback_token_issued",
  "bot.callback_token_revoked",

  /*
   * One Bot handing work to another.
   *
   * BOTH OUTCOMES, and the refused one is the more important of the pair. A hop that happened is
   * visible in the transcript anyway; a hop that was refused is invisible everywhere else, and
   * "why did this Bot not ask the specialist" is a question somebody asks about an answer that came
   * back thin. The refusal row names which cap or which missing grant stopped it.
   *
   * `agent.handoff_offered` is written when the hop is accepted and made durable, not when the other
   * Bot answers. The two are minutes apart on a busy cluster, and a trail that only recorded
   * completion would be silent about work that was accepted and then lost.
   */
  "agent.handoff_offered",
  "agent.handoff_refused",
  /*
   * And what became of one, which is a different question from whether it was accepted.
   *
   * `delivered` is the other Bot's turn being on record. `failed` is a hop that will be tried again.
   * `retried` is the one worth its own name: a hop on its second attempt may already have run that
   * Bot, spent a model call and posted an answer before its owner died, so a person looking at two
   * similar answers can tell a duplicate from a mystery.
   */
  "agent.handoff_delivered",
  "agent.handoff_failed",
  "agent.handoff_retried",
  /*
   * A Bot asking a person instead.
   *
   * The counterpart to the rows above, and the one that says a chain stopped on purpose. Without it
   * a Bot that correctly refused to guess looks identical to one that ran out of things to try: both
   * end in a sentence to the person and neither leaves a trace of the decision.
   *
   * `agent.escalation_failed` is a question that reached nobody. It is the row worth finding later:
   * the Bot stopped, the person was never asked, and nothing else anywhere says so.
   */
  "agent.escalated",
  "agent.escalation_failed",
  /*
   * A worker's bearer secret did not check out at `/internal/routines/run`, and every routine this
   * deployment has stopped firing until somebody notices.
   *
   * Recorded because that route answers a refusal with the exact same 401 for a missing header, a
   * wrong secret, and a deployment that never configured one — deliberately, so a caller cannot tell
   * those apart from the wire. Which means the wire is also the only place this trail could otherwise
   * be read from, and it was told nothing. `payload.reason` carries the distinction the response
   * withholds; the offered credential never does.
   */
  "routines.dispatch_refused",
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

export type AuditEventInput = {
  eventType: AuditEventType;
  targetType: string;
  targetId?: string;
  actorUserId?: string;
  payload: Record<string, unknown>;
};

export type AuditStore = {
  insert: (event: AuditEventInput) => Promise<void>;
};

export type AuditEvent = {
  id: string;
  actorUserId: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AuditEventQuery = {
  cursor?: string;
  limit: number;
  /**
   * One event type, or several separated by commas.
   *
   * Several, because the questions people arrive with cut across the events that answer them: "was
   * anything blocked" is a computer action refused, a component refused AND an MCP call rejected,
   * and a filter that returns only the first quietly hides two thirds of the refusals.
   */
  eventType?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
};

export type AuditReader = {
  list: (query: AuditEventQuery) => Promise<{
    events: AuditEvent[];
    nextCursor?: string;
  }>;
};

type AuditCursor = {
  createdAt: string;
  id: string;
};

function normalizedKey(key: string) {
  return key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isSensitiveKey(key: string) {
  return (
    sensitiveKeys.has(key.toLowerCase()) ||
    sensitiveKeys.has(normalizedKey(key))
  );
}

export function redactAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuditPayload);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : redactAuditPayload(nestedValue),
    ]),
  );
}

export async function recordAuditEvent(
  store: AuditStore,
  event: AuditEventInput,
) {
  await store.insert({
    ...event,
    payload: redactAuditPayload(event.payload) as Record<string, unknown>,
  });
}

export function createAuditStore(database: Database): AuditStore {
  return {
    insert: async (event) => {
      await database.insert(auditEvents).values(event);
    },
  };
}

function encodeCursor(cursor: AuditCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string): AuditCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as AuditCursor;

    if (!parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) {
      throw new Error("invalid cursor");
    }
    return parsed;
  } catch {
    throw new Error("cursor must be a valid audit page cursor");
  }
}

export function createAuditReader(database: Database): AuditReader {
  return {
    list: async (query) => {
      const requestedTypes = (query.eventType ?? "")
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean);
      const conditions = [
        requestedTypes.length === 1
          ? eq(auditEvents.eventType, requestedTypes[0] as string)
          : requestedTypes.length > 1
            ? inArray(auditEvents.eventType, requestedTypes)
            : undefined,
        query.actorUserId
          ? eq(auditEvents.actorUserId, query.actorUserId)
          : undefined,
        query.targetType
          ? eq(auditEvents.targetType, query.targetType)
          : undefined,
        query.targetId ? eq(auditEvents.targetId, query.targetId) : undefined,
        query.from
          ? gt(auditEvents.createdAt, new Date(query.from))
          : undefined,
        query.to ? lt(auditEvents.createdAt, new Date(query.to)) : undefined,
      ];
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;

      if (cursor) {
        conditions.push(
          or(
            lt(auditEvents.createdAt, new Date(cursor.createdAt)),
            and(
              eq(auditEvents.createdAt, new Date(cursor.createdAt)),
              lt(auditEvents.id, cursor.id),
            ),
          ),
        );
      }

      const rows = await database
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(query.limit + 1);
      const hasNextPage = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);

      return {
        events: page.map((event) => ({
          ...event,
          createdAt: event.createdAt.toISOString(),
          payload: event.payload as Record<string, unknown>,
        })),
        nextCursor:
          hasNextPage && last
            ? encodeCursor({
                id: last.id,
                createdAt: last.createdAt.toISOString(),
              })
            : undefined,
      };
    },
  };
}

export function auditQueryFromUrl(url: URL): AuditEventQuery {
  const requestedLimit = Number.parseInt(
    url.searchParams.get("limit") ?? "50",
    10,
  );
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 50;
  const optional = (name: string) => url.searchParams.get(name) ?? undefined;

  return {
    cursor: optional("cursor"),
    limit,
    eventType: optional("eventType"),
    actorUserId: optional("actorUserId"),
    targetType: optional("targetType"),
    targetId: optional("targetId"),
    from: optional("from"),
    to: optional("to"),
  };
}
