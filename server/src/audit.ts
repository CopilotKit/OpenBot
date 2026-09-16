import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Database } from "./db/client";
import { auditEvents } from "./db/schema";
import { parsePageLimit } from "./paging";

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
   * One person's brokered account was exercised with a real call, to see whether it is really there.
   *
   * THE ONE EXECUTION OF AN APP'S OWN ACTION THAT HAPPENS OUTSIDE `callTool`, which is why it is
   * written down on its own instead of joining the `mcp.call_*` family. Everything that surrounds a
   * vendor call on the ordinary path is absent from this one: no grant is consulted, no policy is
   * evaluated, no arguments are inspected, and no `mcp.call_succeeded`, `mcp.call_rejected` or
   * `mcp.call_failed` row is left behind it. An action ran at a vendor and the trail's tool-call
   * family says nothing about it, so this row is the whole of what is recorded.
   *
   * WHAT MAKES THAT SAFE IS THE SHAPE OF THE CALL RATHER THAN ANYBODY'S CARE. The action is fixed:
   * the adapter picks it out of the metadata this deployment already recorded for the app, not out
   * of anything a caller sent; it is sent with no arguments at all, so there is nothing for content
   * inspection to have missed; and the only two callers are the connect step and a person
   * re-checking their own connection. Those three properties are the protection. A later change
   * that let the action, the arguments or the callers vary would not be loosening a check that is
   * merely skipped here — it would be removing the reason the check can be skipped at all, and the
   * one call in this deployment that reaches a vendor unexamined would start taking instructions.
   *
   * THE ROW NAMES A PERSON AND HAS NO BOT IN IT, which is not new on this trail and must not be
   * read as such. `mcp.callback_refused` deliberately names none, and `mcp.account_connected` and
   * `mcp.account_disconnected` are both filed against the person whose account it was, so code that
   * reads a Bot out of every `mcp.*` payload was already wrong before this row existed. What IS new
   * is a vendor action with no `mcp.call_*` row beside it: anybody reconciling this trail against
   * an app's own logs has a call here to account for that the tool-call rows will never mention.
   * Borrowing a Bot to make the row look uniform with its neighbours would answer that by lying —
   * a call somebody made about their own account, filed against a Bot that never ran, is the
   * confidently wrong kind of entry that `mcp.call_failed` exists to keep off this trail.
   */
  "mcp.connection_verified",
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
   * `vendorRevocationRequested` says whether the grant at the vendor was asked to be withdrawn as
   * well. It is false for every credential this deployment holds in its own vault: removing
   * somebody stops us holding a usable secret, and the grant at Google outlives it until it is
   * revoked there, which nothing on that path asks for. It is true for a brokered account whose
   * withdrawal Composio accepted — accepted rather than completed, because the upstream revocation
   * runs as a background job with no supported way to poll it, which is why the field is named for
   * the ask. Recorded rather than glossed, because a row that implied otherwise would be worse
   * than no row, and this field once did exactly that: it was called `vendorRevoked` and said true
   * while the grant at Google stood untouched.
   */
  "mcp.account_disconnected",
  // Every action a Bot takes on its computer, allowed or refused. Both, always: a trail that records
  // only what was permitted cannot answer whether the Bot tried.
  "computer.action_allowed",
  "computer.action_refused",
  // Permitted by policy, attempted, and did not succeed. Its own type because "allowed" reads as
  // "happened", and a trail that cannot tell those apart misleads exactly when it matters most.
  "computer.action_failed",
  // Permitted, attempted, and stopped mid-action by a person pressing Stop. Kept apart from
  // `action_failed` because a stop is not an outage: a count of failures that folds in every Stop
  // reports a broken computer where somebody simply changed their mind.
  "computer.action_stopped",
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

/** What caused a row, where `actorUserId` is only whose authority it borrowed. */
export type AuditInitiator =
  | { kind: "person" }
  | { kind: "deployment" }
  | { kind: "routine"; id: string }
  | { kind: "handoff"; id: string };

export const PERSON_INITIATOR: AuditInitiator = { kind: "person" };

/** The deployment acting as itself: at start-up, or refusing a caller it could not identify. */
export const DEPLOYMENT_INITIATOR: AuditInitiator = { kind: "deployment" };

/*
 * The vocabulary, kept as the declaration of what a row's `initiator_kind` can be.
 *
 * It no longer screens the `initiatorKind` filter. Screening there dropped an unrecognised kind
 * from the requested set, and a requested set left empty widened back into no filter at all; see
 * `matchesRequested`. An unrecognised kind is now simply a kind no row carries.
 */
export const auditInitiatorKinds = [
  "person",
  "deployment",
  "routine",
  "handoff",
] as const;

export type AuditInitiatorKind = (typeof auditInitiatorKinds)[number];

export type AuditEventInput = {
  eventType: AuditEventType;
  targetType: string;
  targetId?: string;
  actorUserId?: string;
  /** Omitted means a person did it. */
  initiator?: AuditInitiator;
  payload: Record<string, unknown>;
};

export type AuditStore = {
  insert: (event: AuditEventInput) => Promise<void>;
};

export type AuditEvent = {
  id: string;
  actorUserId: string | null;
  /** Read back as written, not narrowed to the union. */
  initiatorKind: string;
  initiatorId: string | null;
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
  /** One kind, or several separated by commas, the way `eventType` takes several. */
  initiatorKind?: string;
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

function initiatorColumns(initiator: AuditInitiator | undefined) {
  if (!initiator)
    return { initiatorKind: "person" as const, initiatorId: null };
  if (initiator.kind === "person" || initiator.kind === "deployment") {
    return { initiatorKind: initiator.kind, initiatorId: null };
  }
  return { initiatorKind: initiator.kind, initiatorId: initiator.id };
}

export function createAuditStore(database: Database): AuditStore {
  return {
    insert: async ({ initiator, ...event }) => {
      await database.insert(auditEvents).values({
        ...event,
        ...initiatorColumns(initiator),
        payload: redactAuditPayload(event.payload) as Record<string, unknown>,
      });
    },
  };
}

function encodeCursor(cursor: AuditCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export class AuditQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditQueryError";
  }
}

/**
 * The shape `audit_events.id` is, because that is what a cursor's id is compared against.
 *
 * Not a taste in ids: `lt(auditEvents.id, cursor.id)` is the DATABASE parsing this string, and
 * anything it cannot parse is `invalid input syntax for type uuid` raised from inside the reader.
 * Any version and any variant, because what the column accepts is what this must.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A caller's page marker, read as the two values the query builder will actually bind.
 *
 * WHAT ARRIVES HERE IS A STRING SOMEBODY TYPED. The cast below used to say `AuditCursor` outright,
 * which was a promise nobody could keep: this is `JSON.parse` over base64 out of a query parameter,
 * so the fields hold whatever the caller put in them — a stale bookmark from another deployment's
 * trail, a hand-edited link, a cursor from a screen that has since changed shape. It says
 * `Partial<AuditCursor>` now so that the checks below are the only thing narrowing it, and it
 * admits `null` and `undefined` because `JSON.parse` answers both.
 *
 * THE ID IS CHECKED AS A UUID AND NOT MERELY AS PRESENT, which is the whole of this function's
 * history. It asked `!parsed.id`, so every truthy value passed: `"event-1"`, a number, an object.
 * All three reach `lt(auditEvents.id, cursor.id)` in {@link createAuditReader}, where PostgreSQL
 * answers `invalid input syntax for type uuid` — or, for the number, `operator does not exist: uuid
 * < integer`. That is a `DrizzleQueryError` rather than an {@link AuditQueryError}, so it goes
 * straight past the admin route's catch and leaves as a 500 with the statement and every bound
 * value in its message. The route's 400 exists for exactly this: a cursor the server cannot read is
 * the caller's to fix, the way a bad `from` or `to` already is. The only id a cursor can honestly
 * carry is one {@link encodeCursor} wrote off a row, and that is always a uuid.
 *
 * AND THE TIMESTAMP IS CHECKED AS A STRING BEFORE IT IS CHECKED AS A DATE, because `Date.parse`
 * stringifies whatever it is handed and the reader does not. A `createdAt` of `2020` parses as the
 * YEAR 2020 and passes; `new Date(2020)` in the query builder is 2020 MILLISECONDS after 1970. The
 * two readings of one field differ by fifty years, the endpoint answers 200, and the page comes
 * from the wrong end of the trail with nothing saying so. A silent wrong page on the record of
 * whose credential was spent on what is worse than a refusal, so the shape is settled here.
 *
 * WHAT IS RETURNED IS THE TWO FIELDS, rebuilt, so nothing else the caller packed into the cursor
 * travels on into the query.
 */
function decodeCursor(cursor: string): AuditCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<AuditCursor> | null | undefined;

    if (
      typeof parsed?.id !== "string" ||
      !UUID.test(parsed.id) ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(Date.parse(parsed.createdAt))
    ) {
      throw new AuditQueryError("cursor must be a valid audit page cursor");
    }
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch (error) {
    if (error instanceof AuditQueryError) throw error;
    throw new AuditQueryError("cursor must be a valid audit page cursor");
  }
}

/**
 * A comma-separated filter, read as the set of values it names.
 *
 * `undefined` means the caller did not ask, and the column goes unconstrained. `[]` means the caller
 * did ask, and named nothing this trail could hold — a different answer, and the one the conditions
 * below have to keep telling apart.
 *
 * A blank value counts as not asking, the way a blank `?limit=` still reads as the default page.
 * Anything else the caller typed is an ask.
 */
function requestedValues(raw: string | undefined) {
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The condition a requested set puts on a column, including the condition that nothing satisfies.
 *
 * An asked-for set that came out empty must narrow to nothing. It used to widen instead: both
 * comma-separated filters collapsed an empty set into `undefined`, which `and(...)` drops, so
 * `?initiatorKind=nonsense` — where the unrecognised kind was screened out of the set — answered
 * the question "what did this initiator do" with every row in the trail, indistinguishable from a
 * real result. On the record of whose credential was spent on what, handing back everything is the
 * wrong direction to fail.
 *
 * A value that matches nothing answers empty rather than 400, matching how every other value
 * parameter on this endpoint already behaves: `eventType`, `actorUserId`, `targetType` and
 * `targetId` all take a free-form string and answer with whatever it matches, and `eventType` names
 * a closed vocabulary just as `initiatorKind` does. What earns a 400 here is a value that cannot be
 * read at all — `from`, `to`, `cursor` — not one that reads fine and names no row. Rejecting an
 * unknown kind outright would also break `?initiatorKind=routine,nonsense`, which a caller unioning
 * kinds can still expect to answer for the kind it did name.
 */
function matchesRequested(column: PgColumn, values: string[] | undefined) {
  if (!values) return undefined;
  const [first, ...rest] = values;
  if (first === undefined) return sql`false`;
  if (rest.length === 0) return eq(column, first);
  return inArray(column, [first, ...rest]);
}

export function createAuditReader(database: Database): AuditReader {
  return {
    list: async (query) => {
      const conditions = [
        matchesRequested(
          auditEvents.eventType,
          requestedValues(query.eventType),
        ),
        query.actorUserId
          ? eq(auditEvents.actorUserId, query.actorUserId)
          : undefined,
        matchesRequested(
          auditEvents.initiatorKind,
          requestedValues(query.initiatorKind),
        ),
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
        // Bound as text and cast by PostgreSQL, not as a `Date`, which would drop the microseconds
        // the cursor below carries.
        const createdAt = sql`${cursor.createdAt}::timestamptz`;
        conditions.push(
          or(
            lt(auditEvents.createdAt, createdAt),
            and(
              eq(auditEvents.createdAt, createdAt),
              lt(auditEvents.id, cursor.id),
            ),
          ),
        );
      }

      const rows = await database
        .select({
          ...getTableColumns(auditEvents),
          /*
           * The row's own timestamp to the microsecond, for the cursor only.
           *
           * `created_at` keeps microseconds and a `Date` keeps milliseconds, so a cursor made from
           * `createdAt` named a moment just before the row it came from. The rows the next page
           * should have started with, written earlier in that same millisecond or at the same
           * instant, then compared as newer than the cursor and were on no page at all.
           */
          cursorCreatedAt: sql<string>`to_char(${auditEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(query.limit + 1);
      const hasNextPage = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);

      return {
        events: page.map(({ cursorCreatedAt: _cursorOnly, ...event }) => ({
          ...event,
          createdAt: event.createdAt.toISOString(),
          payload: event.payload as Record<string, unknown>,
        })),
        nextCursor:
          hasNextPage && last
            ? encodeCursor({
                id: last.id,
                createdAt: last.cursorCreatedAt,
              })
            : undefined,
      };
    },
  };
}

export function auditQueryFromUrl(url: URL): AuditEventQuery {
  /*
   * Parsed strictly, like every other paged list. This used to trim and require `/^\d+$/`
   * but fall back to 50 on anything else, so `?limit=abc`, `?limit=12abc`, `?limit=3.9`
   * and `?limit=` all silently returned the default page while `?from=garbage` on the same
   * endpoint answered 400. A typo in the page size is a caller error and names the parameter.
   */
  const parsedLimit = parsePageLimit(url.searchParams.get("limit"), 100);
  if (!parsedLimit.ok) {
    throw new AuditQueryError(parsedLimit.error);
  }
  const limit = parsedLimit.limit ?? 50;
  const optional = (name: string) => url.searchParams.get(name) ?? undefined;

  const from = optional("from");
  if (from !== undefined && Number.isNaN(Date.parse(from))) {
    throw new AuditQueryError('Query parameter "from" must be a valid date.');
  }
  const to = optional("to");
  if (to !== undefined && Number.isNaN(Date.parse(to))) {
    throw new AuditQueryError('Query parameter "to" must be a valid date.');
  }

  /*
   * Fail fast on a stale or hand-edited bookmark. Without this the raw string travels into
   * `createAuditReader.list`, where `decodeCursor` threw a generic `Error` that escaped the
   * route's `AuditQueryError` catch as a 500. A corrupt cursor is a caller error, not a server
   * failure, and answers 400 like a bad `from`/`to` already does.
   */
  const cursor = optional("cursor");
  if (cursor !== undefined) {
    decodeCursor(cursor);
  }

  return {
    cursor,
    limit,
    eventType: optional("eventType"),
    actorUserId: optional("actorUserId"),
    initiatorKind: optional("initiatorKind"),
    targetType: optional("targetType"),
    targetId: optional("targetId"),
    from,
    to,
  };
}
