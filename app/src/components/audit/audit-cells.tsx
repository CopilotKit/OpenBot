import { type AuditOutcome, outcomeOf } from "@/lib/audit/outcome";
import { silenceOf } from "@/lib/audit/silence";

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

/** Strip the internal computer tool namespace for display. */
export function whatText(event: AuditEvent): string {
  const action = event.payload?.action;
  return typeof action === "string"
    ? action.replace("computer_", "")
    : event.eventType;
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

export function startedByText(event: AuditEvent, nameFor: NameFor): string {
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
      return "A responsibility";
    case "deployment":
      return "This deployment";
    default:
      return "A person";
  }
}

export function decisionText(event: AuditEvent): string {
  const payload = event.payload ?? {};
  const outcome = outcomeOf(event.eventType);
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
  return (
    routed ??
    DECISIONS[event.eventType] ??
    (outcome === "refused"
      ? "Blocked"
      : outcome === "did-not-happen"
        ? "Did not happen"
        : "Allowed")
  );
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
  const failed = outcomeOf(event.eventType) === "did-not-happen";
  const lines: string[] = [];
  // Refusal reasons mirror the conversation-facing reason.
  if (
    (event.eventType === "component.refused" ||
      event.eventType === "component.function_refused" ||
      event.eventType === "mcp.call_rejected") &&
    typeof payload.reason === "string"
  )
    lines.push(payload.reason);
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
export function searchTextOf(event: AuditEvent, nameFor: NameFor): string {
  return [
    whatText(event),
    subjectText(event),
    hostText(event),
    botText(event, nameFor),
    startedByText(event, nameFor),
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
  return (
    <>
      {!subject ? (
        <span className="text-muted-foreground">-</span>
      ) : mono ? (
        <span className="font-mono text-xs">{subject}</span>
      ) : typeof element === "object" && element?.name ? (
        <span>
          {element.name}
          {element.role ? (
            <span className="text-muted-foreground"> ({element.role})</span>
          ) : null}
        </span>
      ) : (
        <span className="text-muted-foreground">{subject}</span>
      )}
      {host ? (
        <div className="text-muted-foreground text-xs">{host}</div>
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
  // Keep the immutable bot id available even when names collide.
  return bot ? (
    <span className="text-muted-foreground" title={bot}>
      {nameFor(bot)}
    </span>
  ) : (
    <span className="text-muted-foreground">-</span>
  );
}

export function StartedByCell({
  event,
  nameFor,
}: {
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
      title={unattended ? (event.initiatorId ?? undefined) : undefined}
    >
      {startedByText(event, nameFor)}
    </span>
  );
}

export function DecisionCell({ event }: { event: AuditEvent }) {
  const outcome = outcomeOf(event.eventType);
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
         * A width rather than a max-width, because the table lays itself out from its content and a
         * max-width on a block inside a cell does not constrain that. A router's reason is a
         * sentence a model wrote, and left unbounded in the last column it pushes the table wider
         * than the pane.
         */
        <div
          className="mt-0.5 w-[22rem] max-w-full break-words text-muted-foreground text-xs"
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
