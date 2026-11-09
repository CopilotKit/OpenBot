/**
 * The audit trail's payload filters, in SQL: which app, which tool, read or write, what an action
 * did, and which boundary rule refused it.
 *
 * Each is asked of PostgreSQL over the row's own `payload`, so a filter answers for the whole trail
 * and not only the newest page in the browser. Each also names the event types it applies to, so a
 * row that merely happens to carry a `server` or a `tool` key (a credential, an approval) is never
 * mistaken for an app call, and so the planner can start from `audit_events_type_time_idx` rather
 * than the whole table.
 *
 * NO INDEX OF THEIR OWN, measured rather than assumed. Over 1.2 million rows (50 Bots for 90 days,
 * 240,000 of them app calls), the newest page of 50 took 2 ms for one app, 4 ms for one tool, 0.3 ms
 * for one intent and 43 ms for one rule; the slowest shape, an app and an effect the planner
 * misjudges, took 185 ms, and an app with no calls for the Bot asked about 148 ms. An expression
 * index on the app took those two to 104 ms and 40 ms. Not worth a sixth index on the table every
 * action writes to, and the `bot` filter beside them has never had one either.
 */
import {
  APP_CALL_EVENT_TYPES,
  type AuditIntent,
  appKey,
  RULE_REFUSAL_EVENT_TYPES,
} from "@openbot/shared/audit-filters";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { auditEvents } from "./db/schema";

/** Every row about one action a Bot took on a computer, its own or a folder on the person's. */
const COMPUTER_ACTION_EVENT_TYPES = [
  "computer.action_allowed",
  "computer.action_refused",
  "computer.action_failed",
  "computer.action_stopped",
] as const;

const payloadText = (key: string) =>
  sql<string>`${auditEvents.payload} ->> ${sql.raw(`'${key}'`)}`;

/**
 * {@link appKey} in SQL: the broker prefix dropped, lower-cased, letters and digits only.
 * Kept beside the TypeScript one by `audit-payload-filters.integration.test.ts`.
 */
export function appKeySql(server: SQL) {
  return sql<string>`regexp_replace(lower(regexp_replace(${server}, '^(composio|arcade)-', '', 'i')), '[^a-z0-9]', '', 'g')`;
}

const isAppCall = () =>
  inArray(auditEvents.eventType, [...APP_CALL_EVENT_TYPES]);
const isComputerAction = () =>
  inArray(auditEvents.eventType, [...COMPUTER_ACTION_EVENT_TYPES]);

/** A condition nothing satisfies, for a filter that was asked for and named nothing usable. */
const NOTHING = sql`false`;

/**
 * One person's rows: those written with them as the actor, and the app calls made on their
 * authority.
 *
 * An app call names its person only in its payload (`actor`, see `callTool`), never in the column,
 * so "what did Bots do as Dana" asked of the column alone left out every app call made with Dana's
 * accounts, and answered as though there were none.
 */
export function actorCondition(value: string | undefined) {
  if (!value) return undefined;
  return or(
    eq(auditEvents.actorUserId, value),
    and(isAppCall(), sql`${payloadText("actor")} = ${value}`),
  );
}

/** App calls to any of these apps, matched by {@link appKey} whichever broker carried them. */
export function appCondition(values: string[] | undefined) {
  if (!values) return undefined;
  const keys = [...new Set(values.map(appKey).filter(Boolean))];
  if (keys.length === 0) return NOTHING;
  return and(isAppCall(), inArray(appKeySql(payloadText("server")), keys));
}

/** App calls of any of these tools, by the name the trail records, in any case. */
export function toolCondition(values: string[] | undefined) {
  if (!values) return undefined;
  const tools = [...new Set(values.map((value) => value.toLowerCase()))];
  if (tools.length === 0) return NOTHING;
  return and(isAppCall(), inArray(sql`lower(${payloadText("tool")})`, tools));
}

/** App calls that only read, or that change something, as the call was judged at the time. */
export function effectCondition(value: string | undefined) {
  if (value === undefined || value === "") return undefined;
  return and(isAppCall(), sql`${payloadText("effect")} = ${value}`);
}

/**
 * The keys that press what a form activates, after `mainKey` in `computer/gateway.ts` drops the
 * modifiers held for them. `Shift+Enter` is Enter; `Shift++` is the plus key itself.
 */
const ACTIVATING = "(Enter|NumpadEnter|Space| |\n|\r)";
/*
 * `mainKey` splits on a `+` only when it follows a character it has not just split on, so a key
 * activates when it is one of the above alone, after an even run of `+` from the start (each pair a
 * plus key and its separator), or after an odd run of `+` that follows anything else.
 */
const ACTIVATING_KEY = `^(\\+\\+)*${ACTIVATING}$|[^+](\\+\\+)*\\+${ACTIVATING}$`;

function activatingKey() {
  return sql`coalesce(${payloadText("key")} ~ ${ACTIVATING_KEY}, false)`;
}

function actionIn(actions: string[]) {
  return inArray(payloadText("action"), actions);
}

/**
 * What one intent is, over a row, as `intentOf` in `computer/gateway.ts` derives it at decision
 * time and the boundaries backtest derives it again. The trail does not store the intent; it stores
 * the tool and the key it was derived from, and this derives it the same way.
 *
 * A folder action on the person's own computer (`host/read_file`) is recorded as a computer action
 * with the same names, and is read as the same intent: "which commands did Bots run" means those too.
 * An app call's intent is its effect, as the boundary is told it.
 */
function intentSql(intent: AuditIntent) {
  switch (intent) {
    case "activate":
      return and(
        isComputerAction(),
        or(
          actionIn(["computer_click"]),
          and(actionIn(["computer_key", "computer_type"]), activatingKey()),
        ),
      );
    case "type":
      return and(
        isComputerAction(),
        actionIn(["computer_key", "computer_type"]),
        sql`not ${activatingKey()}`,
      );
    case "navigate":
      return and(isComputerAction(), actionIn(["computer_navigate"]));
    case "read":
      return and(
        isComputerAction(),
        actionIn([
          "computer_read",
          "computer_snapshot",
          "computer_screenshot",
          "computer_scroll",
        ]),
      );
    case "read_file":
    case "download_file":
    case "write_file":
    case "list_files":
    case "run_command":
      return and(
        isComputerAction(),
        actionIn([`computer_${intent}`, `host/${intent}`]),
      );
    case "read_tool":
      return and(isAppCall(), sql`${payloadText("effect")} = 'read'`);
    case "write_tool":
      return and(isAppCall(), sql`${payloadText("effect")} = 'write'`);
  }
}

const KNOWN_INTENTS = new Set<string>([
  "activate",
  "type",
  "navigate",
  "read",
  "read_file",
  "download_file",
  "write_file",
  "list_files",
  "run_command",
  "read_tool",
  "write_tool",
] satisfies AuditIntent[]);

/** Rows whose action did any of these. An intent the boundary has no word for matches nothing. */
export function intentCondition(values: string[] | undefined) {
  if (!values) return undefined;
  const intents = [...new Set(values)].filter((value) =>
    KNOWN_INTENTS.has(value),
  ) as AuditIntent[];
  if (intents.length === 0) return NOTHING;
  return or(...intents.map(intentSql));
}

/**
 * Refusals by this one boundary rule, matched against the rule's text exactly as the row recorded
 * it (`decision.rule`), which is the text the Boundaries page lists it by.
 */
export function ruleCondition(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined;
  return and(
    inArray(auditEvents.eventType, [...RULE_REFUSAL_EVENT_TYPES]),
    sql`${auditEvents.payload} -> 'decision' ->> 'rule' = ${value}`,
  );
}
