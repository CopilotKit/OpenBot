import { outcomeForPerson } from "@openbot/shared/approval-outcomes";
import { auditActionWords, auditEventWords } from "@openbot/shared/audit-words";
import { Fragment, type ReactNode } from "react";
import { type AuditOutcome, outcomeOf } from "@/lib/audit/outcome";
import { silenceOf } from "@/lib/audit/silence";
import { atStart } from "@/lib/manage-paths";

/** One row as the API returns it. */
export type AuditEvent = {
  id: string;
  actorUserId: string | null;
  /** Absent on a deployment that has not migrated yet. */
  initiatorKind?: string;
  initiatorId?: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type NameFor = (botId: string) => string;

/**
 * Each cell of the Audit table, and the same thing as plain text for the search box.
 *
 * The text versions read the same fields in the same order as the cells, so what a person can see
 * on a row is what they can find it by.
 */

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function whenText(event: AuditEvent): string {
  return WHEN.format(new Date(event.createdAt));
}

const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** The day over the time, so the column is as wide as a date rather than a date and a time. */
export function WhenCell({ event }: { event: AuditEvent }) {
  const at = new Date(event.createdAt);
  return (
    <>
      <div>{DAY.format(at)}</div>
      <div>{TIME.format(at)}</div>
    </>
  );
}

/**
 * An identifier with a break allowed after each `.`, `/`, `_` and `-`, so `mcp.tools_discovered` or
 * a file path wraps at its own seams when the column is narrow, and is never cut mid-word.
 */
function breakable(text: string): ReactNode {
  let at = 0;
  return text.split(/(?<=[./_-])/).map((part) => {
    const start = at;
    at += part.length;
    return (
      <Fragment key={start}>
        {start > 0 ? <wbr /> : null}
        {part}
      </Fragment>
    );
  });
}

/**
 * What was done, with what it was done to beneath it. One column rather than two, so the table
 * fits the Desktop's default window: drawn side by side, What, On, Bot and Started by pushed
 * Decision off the right edge of a 1000px window.
 *
 * In words. `storedName` puts the name the trail keeps it under on hover, for an admin matching a row
 * against the export or a collector; a page anybody can open leaves it off.
 */
export function WhatCell({
  event,
  storedName = false,
}: {
  event: AuditEvent;
  storedName?: boolean;
}) {
  return (
    <>
      <div
        className="font-medium"
        title={storedName ? whatName(event) : undefined}
      >
        {whatText(event)}
      </div>
      <OnCell event={event} />
    </>
  );
}

/** The Bot, with what started it beneath it, for the same reason as {@link WhatCell}. */
export function WhoCell({
  deployment,
  event,
  nameFor,
}: {
  /** What OpenBot itself is called here; see {@link startedByText}. */
  deployment?: string;
  event: AuditEvent;
  nameFor: NameFor;
}) {
  return (
    <>
      <div>
        <BotCell event={event} nameFor={nameFor} />
      </div>
      <div className="text-xs">
        <StartedByCell
          deployment={deployment}
          event={event}
          nameFor={nameFor}
        />
      </div>
    </>
  );
}

/**
 * The action a row is about, as the trail stores it. An approval row is about an action too, and
 * names the tool it was asked about, so it reads as the same action its other rows are; so does an
 * app's tool call, which names its tool as its target.
 */
function actionOf(event: AuditEvent): string | undefined {
  const action =
    event.payload?.action ??
    (event.targetType === "approval" ? event.payload?.tool : undefined);
  if (typeof action === "string") return action;
  const legacy = legacyFolderAction(event);
  if (legacy) return `host/${legacy.operation}`;
  if (
    event.eventType.startsWith("mcp.call") &&
    event.targetType === "mcp_tool" &&
    event.targetId
  )
    return event.targetId;
  return undefined;
}

/**
 * A folder action recorded before folder actions were a computer's (`server/src/host-access/tools.ts`):
 * a `configuration.changed` row naming the operation and how it went. Read in the same words, since
 * the trail cannot be rewritten; it keeps its own event type, so the views by type leave it out.
 */
export function legacyFolderAction(
  event: Pick<AuditEvent, "eventType" | "payload">,
): { operation: string; outcome: string } | undefined {
  const payload = event.payload ?? {};
  return event.eventType === "configuration.changed" &&
    payload.change === "host_access_tool_call" &&
    typeof payload.operation === "string" &&
    typeof payload.outcome === "string"
    ? { operation: payload.operation, outcome: payload.outcome }
    : undefined;
}

/** What a row is about, in the trail's own name for it: for search, and for Admin's hover. */
export function whatName(event: AuditEvent): string {
  return actionOf(event) ?? event.eventType;
}

/** What a row is about, in words: "Save a file", "Choose tools for a run". See `audit-words`. */
export function whatText(event: AuditEvent): string {
  const action = actionOf(event);
  return action ? auditActionWords(action) : auditEventWords(event.eventType);
}

type Element = { role?: string; name?: string } | string | undefined;

/** The row's subject, the part of "On" that is not the page host. */
export function subjectText(event: AuditEvent): string {
  const payload = event.payload ?? {};
  const element = payload.element as Element;
  if (event.eventType === "mcp.tools_discovered")
    return typeof payload.offered === "number" &&
      typeof payload.granted === "number"
      ? `${payload.offered} of ${payload.granted} tools`
      : "";
  if (NAMED_TARGETS.has(event.targetType) && event.targetId)
    return typeof payload.function === "string"
      ? `${event.targetId} · ${payload.function}`
      : event.targetId;
  if (typeof payload.file === "string") return payload.file;
  if (typeof payload.command === "string") return payload.command;
  if (typeof element === "object" && element?.name)
    return element.role ? `${element.name} (${element.role})` : element.name;
  if (typeof element === "string") return element;
  // An app's tool or a folder: where an approval row's action would have acted, when it names no file or page.
  if (
    event.targetType === "approval" &&
    typeof payload.page !== "string" &&
    typeof payload.scope === "string"
  )
    return payload.scope;
  return "";
}

/** The page host under the subject, meaningful only for browser actions. */
export function hostText(event: AuditEvent): string {
  const payload = event.payload ?? {};
  return typeof payload.file !== "string" &&
    typeof payload.command !== "string" &&
    typeof payload.page === "string" &&
    payload.page
    ? hostOf(payload.page)
    : "";
}

/**
 * The Bot a row is about. Actions a Bot took carry it in the payload; events done TO a Bot (routed
 * to it, started, handed work, paused) record it as the target instead, and are just as much its row.
 */
export function botIdOf(event: AuditEvent): string | null {
  if (typeof event.payload?.bot === "string") return event.payload.bot;
  return event.targetType === "agent" && event.targetId ? event.targetId : null;
}

export function botText(event: AuditEvent, nameFor: NameFor): string {
  const bot = botIdOf(event);
  return bot ? nameFor(bot) : "";
}

/**
 * Who started a row, as the row's Started by filter and its line under the Bot both say it.
 * `deployment` is what OpenBot itself is called on this screen: "this deployment" in Admin, and
 * "OpenBot" in the personal edition's Activity, which is anybody's page.
 */
export function startedByText(
  event: AuditEvent,
  nameFor: NameFor,
  deployment = "this deployment",
): string {
  switch (event.initiatorKind) {
    case "routine":
      return "A routine";
    case "handoff":
      return event.initiatorId
        ? `Handed on by ${nameFor(event.initiatorId)}`
        : "Handed on";
    case "memory":
      return "A memory source";
    case "responsibility":
      return "A goal";
    case "deployment":
      return atStart(deployment);
    default:
      return "A person";
  }
}

export function decisionText(event: AuditEvent): string {
  const payload = event.payload ?? {};
  const outcome = outcomeOf(event);
  /*
   * Three different things, and the difference is what somebody comes to this row to find out.
   *
   * A person naming a coworker, the router matching one, and the router giving up and using the
   * default are not the same event, and one label covering all three would make the row worth less
   * than the reason line under it. Nothing here is a refusal, so none of them take the refusal
   * colour.
   */
  const routed =
    event.eventType === "channel.routed"
      ? payload.viaMention === true
        ? "The person chose this Bot"
        : payload.fallback === true
          ? "Sent to the default Bot"
          : "Sent to the Bot it was meant for"
      : null;
  const legacy = legacyFolderAction(event);
  return (
    routed ??
    approvalText(event) ??
    (legacy?.outcome === "requested" ? "Asked for" : undefined) ??
    (legacy ? undefined : DECISIONS[event.eventType]) ??
    (outcome === "refused"
      ? "Blocked"
      : outcome === "did-not-happen"
        ? "Did not happen"
        : "Allowed")
  );
}

/**
 * What an approval row says: the gate asking or deciding, or the person's answer. One event type
 * covers every answer, so the answer is read from the row, and a denial never falls through to
 * "Allowed".
 */
function approvalText(event: AuditEvent): string | undefined {
  const payload = event.payload ?? {};
  if (event.eventType === "approval.person_decided")
    return typeof payload.decision === "string"
      ? PERSON_DECISIONS[payload.decision]
      : undefined;
  if (event.eventType === "approval.evaluated") {
    const behaviour = (payload.outcome as { behaviour?: unknown } | undefined)
      ?.behaviour;
    return typeof behaviour === "string"
      ? GATE_DECISIONS[behaviour]
      : undefined;
  }
  return undefined;
}

const PERSON_DECISIONS: Record<string, string> = {
  allow_once: "Allowed once by a person",
  allow_always: "Always allowed by a person",
  deny: "Denied by a person",
  handled: "Done by a person",
};

const GATE_DECISIONS: Record<string, string> = {
  allow: "Allowed without asking",
  ask: "Asked a person first",
  hand_off: "Handed to a person",
  deny: "Blocked",
};

/**
 * Why an action the policy allowed was refused anyway, in a person's words. The Bot is told why in
 * sentences written for it; the shared table turns them into the ones a person reads.
 */
function refusalLine(payload: Record<string, unknown>): string | undefined {
  if (payload.refusal === "person_declined")
    return "A person denied it when asked.";
  if (payload.refusal === "approval" && typeof payload.reason === "string")
    return outcomeForPerson(payload.reason);
  return undefined;
}

/** Every reason line under the decision, in the order the cell draws them. */
export function decisionDetails(event: AuditEvent): string[] {
  const payload = event.payload ?? {};
  const decision = (payload.decision ?? {}) as {
    allowed?: boolean;
    mode?: string;
    rule?: string | null;
    carriedOut?: boolean;
  };
  const failed = outcomeOf(event) === "did-not-happen";
  const lines: string[] = [];
  const refused =
    event.eventType === "computer.action_refused" ||
    event.eventType === "mcp.call_rejected"
      ? refusalLine(payload)
      : undefined;
  if (refused) lines.push(refused);
  // Refusal reasons mirror the conversation-facing reason.
  else if (
    (event.eventType === "component.refused" ||
      event.eventType === "component.function_refused" ||
      event.eventType === "mcp.call_rejected" ||
      // A folder action the desktop or its grant turned away says why; see host-access/tools.ts.
      event.eventType === "computer.action_refused") &&
    typeof payload.reason === "string"
  )
    lines.push(payload.reason);
  // Why the gate asked, allowed or refused, and why a request stopped waiting.
  const gate = (payload.outcome ?? {}) as { reason?: unknown };
  if (
    event.eventType === "approval.evaluated" &&
    typeof gate.reason === "string"
  )
    lines.push(outcomeForPerson(gate.reason));
  if (
    event.eventType === "approval.withdrawn" &&
    typeof payload.reason === "string"
  )
    lines.push(outcomeForPerson(payload.reason));
  /*
   * Why this run was offered what it was, which is the only part of a discovery row that cannot be
   * worked out from the numbers. "Nothing declared" and "selector unavailable" both offer everything
   * and mean entirely different things about the deployment.
   */
  if (
    event.eventType === "mcp.tools_discovered" &&
    typeof payload.reason === "string"
  )
    lines.push(
      `${DISCOVERY_REASONS[payload.reason] ?? payload.reason}${
        Array.isArray(payload.skills) && payload.skills.length > 0
          ? `: ${payload.skills.join(", ")}`
          : ""
      }`,
    );
  if (
    event.eventType === "mcp.callback_refused" &&
    typeof payload.refusal === "string"
  )
    lines.push(payload.refusal);
  /*
   * Why the conversation went where it went, which is the whole reason the row is written. Without
   * it a routing row says "Allowed" and names nobody, which is indistinguishable from a row that
   * failed to write.
   */
  if (
    event.eventType === "channel.routed" &&
    typeof payload.reason === "string"
  )
    lines.push(payload.reason);
  if (event.eventType === "bot.declined" && typeof payload.reason === "string")
    lines.push(`${payload.reason}, reported by the Bot itself`);
  if (failed && typeof payload.failure === "string")
    lines.push(payload.failure);
  /*
   * The two numbers the stall row is worth reading for. Without them every stalled turn looks the
   * same, and the difference between an endpoint that dies halfway through an answer and one that
   * never begins is the difference between a slow Bot and a dead one.
   */
  const silence =
    event.eventType === "agent.stream_stalled" ? silenceOf(payload) : null;
  if (silence) lines.push(silence);
  // Show concrete policy rules, but suppress the uninformative default `true` allow rule.
  if (decision.rule && decision.rule !== "true") lines.push(decision.rule);
  if (
    decision.mode === "dry-run" &&
    decision.allowed === false &&
    decision.carriedOut
  )
    lines.push("dry-run: recorded, not enforced");
  return lines;
}

/** Everything on a row as one lower-cased string, for the search box. */
export function searchTextOf(
  event: AuditEvent,
  nameFor: NameFor,
  deployment?: string,
): string {
  return [
    whatText(event),
    // The stored name too, so a row is found by what the export and a collector call it.
    whatName(event),
    subjectText(event),
    hostText(event),
    botText(event, nameFor),
    startedByText(event, nameFor, deployment),
    decisionText(event),
    ...decisionDetails(event),
  ]
    .join(" ")
    .toLowerCase();
}

export function OnCell({ event }: { event: AuditEvent }) {
  const payload = event.payload ?? {};
  const element = payload.element as Element;
  const subject = subjectText(event);
  const host = hostText(event);
  /*
   * Named targets, tool counts, files and commands are identifiers and read in mono; a page element
   * is a label and does not.
   */
  const mono =
    event.eventType === "mcp.tools_discovered" ||
    (NAMED_TARGETS.has(event.targetType) && !!event.targetId) ||
    typeof payload.file === "string" ||
    typeof payload.command === "string";
  // Under the action in the What column, so a row with nothing to name draws nothing.
  return (
    <>
      {!subject ? null : mono ? (
        <div className="mt-0.5 font-mono text-xs">{breakable(subject)}</div>
      ) : typeof element === "object" && element?.name ? (
        <div className="mt-0.5">
          {element.name}
          {element.role ? (
            <span className="text-muted-foreground"> ({element.role})</span>
          ) : null}
        </div>
      ) : (
        <div className="mt-0.5 text-muted-foreground">{breakable(subject)}</div>
      )}
      {host ? (
        <div className="text-muted-foreground text-xs">{breakable(host)}</div>
      ) : null}
    </>
  );
}

export function BotCell({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: NameFor;
}) {
  const bot = botIdOf(event);
  // The name and nothing else, a tooltip included: a person never reads a Bot's id. The CSV keeps it.
  return bot ? (
    <span className="text-muted-foreground">{nameFor(bot)}</span>
  ) : (
    <span className="text-muted-foreground">-</span>
  );
}

export function StartedByCell({
  deployment,
  event,
  nameFor,
}: {
  deployment?: string;
  event: AuditEvent;
  nameFor: NameFor;
}) {
  // Anything that ran with nobody watching is the colour of a warning; a person or the deployment is not.
  const unattended =
    event.initiatorKind === "routine" ||
    event.initiatorKind === "handoff" ||
    event.initiatorKind === "responsibility" ||
    event.initiatorKind === "memory";
  return (
    <span
      className={
        unattended
          ? "font-medium text-amber-600 dark:text-amber-500"
          : "text-muted-foreground"
      }
    >
      {startedByLine(startedByText(event, nameFor, deployment))}
    </span>
  );
}

/**
 * Under the Bot's name, so it says what it is: "Started by a routine", "Handed on by Scout",
 * "Started by OpenBot". Only a leading "A" or "This" is lowered; a name keeps its capitals.
 */
export function startedByLine(text: string): string {
  return text.startsWith("Handed on")
    ? text
    : `Started by ${text.replace(/^(A|This) /, (word) => word.toLowerCase())}`;
}

export function DecisionCell({ event }: { event: AuditEvent }) {
  const outcome = outcomeOf(event);
  return (
    <>
      <span
        className={
          outcome === "refused"
            ? "font-medium text-destructive"
            : outcome === "did-not-happen"
              ? "font-medium text-amber-600 dark:text-amber-500"
              : "text-muted-foreground"
        }
      >
        {decisionText(event)}
      </span>
      {decisionDetails(event).map((line) => (
        /*
         * A cap on the line, not a width. A fixed 22rem held the Decision column at least that wide,
         * and with the columns beside it pushed the table past a 1000px window. The table gives the
         * column what is left, the sentence wraps inside it, and a long unbroken word (a URL a
         * router quoted) breaks rather than widening the table.
         */
        <div
          className="mt-0.5 max-w-[22rem] text-muted-foreground text-xs [overflow-wrap:anywhere]"
          key={line}
        >
          {line}
        </div>
      ))}
    </>
  );
}

/** The square at the start of each row: what happened, at a glance down the log. */
export const OUTCOME_MARK: Record<AuditOutcome, string> = {
  refused: "bg-destructive",
  "did-not-happen": "bg-amber-500",
  allowed: "bg-muted-foreground/20",
};

/** The faint tint on rows worth stopping at. Allowed rows stay plain. */
export const OUTCOME_ROW: Record<AuditOutcome, string> = {
  refused: "bg-destructive/5 hover:bg-destructive/10",
  "did-not-happen": "bg-amber-500/5 hover:bg-amber-500/10",
  allowed: "",
};

/**
 * Why a run was offered the tools it was, in words rather than in the slug the server writes.
 *
 * Every one of these looks the same from outside: the Bot was handed some tools. The distinction is
 * the difference between a deployment that narrowed on purpose, one that has never declared a skill,
 * and one whose selector could not be reached, and only the last is a fault.
 */
const DISCOVERY_REASONS: Record<string, string> = {
  "under-floor": "Few enough tools to offer them all",
  "nothing-declared": "No skill declares any of these tools",
  unavailable: "Couldn't choose, so all were offered",
  "nothing-chosen": "No skill applied, so all were offered",
  selected: "Chosen by skill",
};

/** Target types whose id is a name worth putting on screen; anything else falls through. */
const NAMED_TARGETS = new Set([
  "component",
  "mcp_tool",
  "mcp_server",
  "skill",
  "credential",
]);

const DECISIONS: Record<string, string> = {
  "bot.declined": "The Bot declined",
  // Not a refusal, so not the refusal colour: nothing was blocked. The Bot was asked and never
  // answered, which is the same complaint as an action that was allowed and then did not happen.
  "agent.stream_stalled": "The Bot stopped responding",
  "agent.tool_limit_refused": "Too many tools for its model",
  "computer.policy_loaded": "Boundary at start-up",
  "computer.isolation_loaded": "Isolation at start-up",
  "computer.control_taken": "A person took control",
  "computer.control_released": "Control went back to the Bot",
  "computer.help_requested": "The Bot asked for help",
  "computer.secret_requested": "The Bot asked for a secret",
  "computer.secret_supplied": "A person supplied a secret",
  "computer.reset": "The computer was reset",
  "computer.browser_cleared": "A person cleared the browser",
  "computer.updated": "The computer was updated",
  "computer.stopped": "A person pressed stop",

  "component.granted": "Granted to this Bot",
  "component.revoked": "Taken away from this Bot",
  "component.published": "Published. Every Bot can use it",
  "component.unpublished": "Unpublished. No Bot can use it",
  "component.draft_saved": "Draft saved, not yet published",
  "component.refused": "Refused",
  "component.function_granted": "Can read this",
  "component.function_revoked": "Can no longer read this",
  "component.function_called": "Read real data",
  "component.function_refused": "Refused",
  // A function failure is execution failure, not a policy refusal.
  "component.function_failed": "Couldn't read it",

  // Not a call and not a decision: the tools this run was allowed to see. Worded so nobody reads it
  // as permission, which it is not — everything named was already granted.
  "mcp.tools_discovered": "Tools offered for one run",
  "mcp.call_succeeded": "Called on this Bot's behalf",
  "mcp.call_rejected": "Blocked",
  "mcp.call_failed": "The server didn't answer",
  // Not "Blocked": nothing about the Bot was judged, because nothing proved which Bot it was.
  "mcp.callback_refused": "Couldn't confirm which Bot it was",

  // A request closed without an answer: asking was turned off, or a rule now allows it.
  "approval.withdrawn": "Withdrawn",

  "configuration.changed": "Configuration changed",
  "credential.created": "Credential saved",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
