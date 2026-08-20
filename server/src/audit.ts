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
  "tool_result",
]);

export const auditEventTypes = [
  "configuration.changed",
  "credential.created",
  "credential.rotated",
  "credential.revoked",
  "connector.sync_succeeded",
  "connector.sync_failed",
  "knowledge.searched",
  "agent.invoked",
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
  "mcp.call_succeeded",
  "mcp.call_rejected",
  // Every action a Bot takes on its computer, allowed or refused. Both, always: a trail that records
  // only what was permitted cannot answer whether the Bot tried.
  "computer.action_allowed",
  "computer.action_refused",
  // Permitted by policy, attempted, and did not succeed. Its own type because "allowed" reads as
  // "happened", and a trail that cannot tell those apart misleads exactly when it matters most.
  "computer.action_failed",
  /**
   * The same call, again, and again.
   *
   * The rows above record actions one at a time, which is the only way to record them and the reason
   * a Bot stuck in a retry loop is invisible here: thirty identical rows look like thirty rows. This
   * one says the thing the sequence cannot, that these are the same call, and how many times.
   *
   * It is not a refusal. Nothing was forbidden and nothing was stopped; a Bot did the same thing
   * again, which is often merely a retry that is about to work. Filing it as a refusal would teach a
   * reader to skim past the refusals that are real, so it is its own type and the audit page gives it
   * its own words.
   *
   * Written when a count crosses a threshold rather than on every repeat, because a row per attempt
   * would bury the attempts themselves under the observation that they kept happening.
   */
  "computer.action_repeated",
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
  /**
   * The boundary stopping to ask a person, and what they said.
   *
   * Three rows rather than a flag on the action, because the three facts are separable and the gaps
   * between them are where the interesting failures live. A question that was asked and never
   * answered leaves only the first row, and that is the shape of "the Bot sat waiting while nobody
   * was watching the screen", which nothing else in this trail would show. An answer that was given
   * and never spent leaves the first two, which is what a stopped run looks like from here.
   *
   * `approval.granted` and `approval.denied` are written by the person answering, under their own
   * actor, minutes after the Bot's turn raised the question and often by somebody else entirely.
   * Folding consent into the action row would credit it to whoever was driving the Bot, which is the
   * one thing an approval trail must never do.
   *
   * Not named for the computer, unlike the rows above, because the same boundary judges a Bot's
   * calls to somebody else's servers and stops to ask about those too. Each row is filed against the
   * thing the question was about, a computer or a tool, so a reader filtering by either sees the
   * question, the answer and the action together rather than a grant filed under a browser for
   * something that happened in Jira.
   */
  "approval.requested",
  "approval.granted",
  "approval.denied",
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
