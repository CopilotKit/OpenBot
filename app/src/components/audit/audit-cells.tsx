import { outcomeForPerson } from "@openbot/shared/approval-outcomes";
import {
  appToolsWords,
  auditActionWords,
  auditChangeWords,
  auditEventWords,
  dataWords,
} from "@openbot/shared/audit-words";
import {
  type ConnectPrompt,
  readConnectPrompt,
} from "@openbot/shared/connect-prompt";
import { isOpenBotActor } from "@openbot/shared/openbot-actor";
import { connectorName, humanise, inFolder } from "@openbot/shared/tool-name";
import {
  Fragment,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type AuditOutcome, outcomeOf } from "@/lib/audit/outcome";
import { silenceOf } from "@/lib/audit/silence";
import { galleryComponent } from "@/lib/copilot/gallery-registry";
import { atStart } from "@/lib/manage-paths";
import { cn } from "@/lib/utils";

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
  /**
   * The name the page found for the row's subject, where the trail stores an id: a skill's title
   * ("Write a skill" for `skill-creator`). Not part of the stored row, so older rows read it too.
   */
  subjectTitle?: string;
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
 * against the export or a collector, and keeps a tool's or an app's stored name under it; a page
 * anybody can open leaves both off and says the tool and the app in words.
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
        {whatText(event, storedName)}
      </div>
      <OnCell event={event} storedNames={storedName} />
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

/**
 * What a row is about, in words: "Save a file", "Choose tools for a run", "Give a Bot tools". See
 * `audit-words`. A configuration row says what changed when its change has words of its own.
 *
 * `storedNames` is false on the personal edition's Activity, where an app given by its one press
 * was nobody's approval (see {@link givenWithoutAsking}).
 */
export function whatText(event: AuditEvent, storedNames = true): string {
  if (!storedNames && givenWithoutAsking(event)) return "Let a Bot use an app";
  const action = actionOf(event);
  if (action) return auditActionWords(action);
  const change =
    event.eventType === "configuration.changed"
      ? auditChangeWords(event.payload ?? {})
      : undefined;
  return change ?? auditEventWords(event.eventType);
}

type Element = { role?: string; name?: string } | string | undefined;

/** The `app/tool` refs a row names: the tools one row gave a Bot, or an app's tools it no longer lists. */
function refsOf(event: AuditEvent): string[] | undefined {
  const refs = event.payload?.refs;
  return Array.isArray(refs) &&
    refs.length > 0 &&
    refs.every((ref) => typeof ref === "string")
    ? refs
    : undefined;
}

/**
 * An app's tool or an app, in words, for a page anybody can open: "Send email on Gmail" for a tool
 * a row gave or took, the app alone ("Gmail") under a call whose What already says the action.
 * Undefined for anything else, which reads as it does in Admin.
 */
function appSubjectWords(event: AuditEvent): string | undefined {
  const payload = event.payload ?? {};
  const target = event.targetId;
  if (event.targetType === "mcp_tool" && target)
    return event.eventType === "configuration.changed"
      ? appToolsWords([target])
      : connectorName(
          target.slice(0, Math.max(target.indexOf("/"), 0)) || target,
        );
  if (event.targetType === "mcp_server" && target) {
    const refs = refsOf(event);
    return refs ? appToolsWords(refs) : connectorName(target);
  }
  // An approval asked about an app's tool names the app as where it would act.
  if (
    event.targetType === "approval" &&
    typeof payload.scope === "string" &&
    typeof payload.tool === "string" &&
    payload.tool.startsWith(`${payload.scope}/`)
  )
    return connectorName(payload.scope);
  return undefined;
}

/**
 * What a row is about in words, for a page anybody can open, where Admin shows the name or id the
 * trail stores: an app or its tools (above), a component by the name the Components gallery gives
 * it ("Data table", not `showTable`), a skill by its name in words (`find-a-document` reads "Find a
 * document"), and a saved key by its provider and key ID, never the key's id. Undefined for
 * anything else, which reads as it does in Admin.
 */
function subjectWords(event: AuditEvent): string | undefined {
  const app = appSubjectWords(event);
  if (app !== undefined) return app;
  const payload = event.payload ?? {};
  const target = event.targetId;
  if (event.targetType === "component" && target) {
    // With the data it was given or read: "Activity report · your Bots' activity".
    const functions = functionsOf(payload);
    return functions
      ? `${componentName(target)} · ${dataWords(functions)}`
      : componentName(target);
  }
  // By the title its page shows ("Write a skill"), or its stored name in words once it is gone.
  if (event.targetType === "skill" && target)
    return event.subjectTitle || humanise(target);
  if (event.targetType === "credential") {
    if (typeof payload.server === "string")
      return connectorName(payload.server);
    const named = [payload.provider, payload.keyId].filter(
      (part): part is string => typeof part === "string" && part !== "",
    );
    return named.join(" · ");
  }
  return undefined;
}

/**
 * The data functions a component row names: one it read or was refused (`function`), or every one
 * OpenBot Personal gave it in one row (`functions`).
 */
function functionsOf(
  payload: Record<string, unknown>,
): readonly string[] | undefined {
  if (typeof payload.function === "string") return [payload.function];
  const functions = payload.functions;
  return Array.isArray(functions) &&
    functions.length > 0 &&
    functions.every((name) => typeof name === "string")
    ? functions
    : undefined;
}

/** A component by its name in the Components gallery, or its stored name in words. */
function componentName(name: string): string {
  return galleryComponent(name)?.title ?? humanise(name);
}

/**
 * The row's subject, the part of "On" that is not the page host. Admin (`storedNames`) reads a tool
 * or an app by the name the trail stores it under; a page anybody can open reads it in words.
 */
export function subjectText(event: AuditEvent, storedNames = true): string {
  const payload = event.payload ?? {};
  const element = payload.element as Element;
  if (event.eventType === "mcp.tools_discovered")
    return typeof payload.offered === "number" &&
      typeof payload.granted === "number"
      ? `${payload.offered} of ${payload.granted} tools`
      : "";
  // What an admin asked the trail, in their words.
  if (event.eventType === "audit.asked" || event.eventType === "what_if.asked")
    return typeof payload.question === "string" ? payload.question : "";
  // Which permission, for whom: one sentence can save several switches, each a row of its own.
  if (event.eventType === "capability.changed")
    return permissionSubject(payload);
  if (!storedNames) {
    const words = subjectWords(event);
    if (words !== undefined) return words;
  } else if (
    event.eventType === "configuration.changed" &&
    payload.change === "plugin_granted"
  ) {
    // Every tool one row gave a Bot, as Admin read them when each had a row of its own.
    const refs = refsOf(event);
    if (refs) return refs.join(", ");
  }
  if (NAMED_TARGETS.has(event.targetType) && event.targetId) {
    const functions = functionsOf(payload);
    return functions
      ? `${event.targetId} · ${functions.join(", ")}`
      : event.targetId;
  }
  /*
   * A step on a folder on the person's computer names the file and the folder it is in, as its card
   * and its line in the conversation do ("todo.txt in share"). Rows written before they named the
   * folder name the file alone.
   */
  const folder =
    typeof payload.folder === "string" && payload.folder
      ? payload.folder
      : undefined;
  if (typeof payload.file === "string")
    return inFolder(payload.file, folder) ?? payload.file;
  if (typeof payload.command === "string")
    return inFolder(payload.command, folder) ?? payload.command;
  const folders = foldersOf(payload);
  if (folders) return folders;
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

/**
 * The folder a person gave a Bot or took from it, or the folders stopping folder access ended, by
 * the name Settings > Computer shows. Rows written before they said so name none.
 */
function foldersOf(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.folder === "string" && payload.folder)
    return payload.folder;
  const folders = payload.folders;
  return Array.isArray(folders) &&
    folders.length > 0 &&
    folders.every((folder) => typeof folder === "string")
    ? folders.join(", ")
    : undefined;
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
 * A folder given to a Bot before its row said `bot` named it as `botId`.
 */
export function botIdOf(event: AuditEvent): string | null {
  if (typeof event.payload?.bot === "string") return event.payload.bot;
  if (
    event.targetType === "host_access" &&
    typeof event.payload?.botId === "string"
  )
    return event.payload.botId;
  // A routine is its Bot's, whether the Bot or a person made it.
  if (
    event.targetType === "routine" &&
    typeof event.payload?.agentId === "string"
  )
    return event.payload.agentId;
  return event.targetType === "agent" && event.targetId ? event.targetId : null;
}

export function botText(event: AuditEvent, nameFor: NameFor): string {
  const bot = botIdOf(event);
  return bot ? nameFor(bot) : "";
}

/**
 * What started a row. Two kinds of row are OpenBot's own change: a configuration row that names
 * OpenBot as its actor (`openbot:always-on`), and a component a build brought, published on arrival
 * (the only publish row with a `note`). Rows written before the server recorded that say a person
 * started them, and the trail cannot be rewritten, so they are read that way here. A row the server
 * says something other than a person started keeps what it says.
 */
function initiatorKindOf(event: AuditEvent): string | undefined {
  if ((event.initiatorKind ?? "person") !== "person")
    return event.initiatorKind;
  const ownChange =
    (event.eventType === "configuration.changed" &&
      isOpenBotActor(event.payload?.actor)) ||
    (event.eventType === "component.published" &&
      typeof event.payload?.note === "string");
  return ownChange ? "deployment" : event.initiatorKind;
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
  switch (initiatorKindOf(event)) {
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

/**
 * An app the personal edition gave a Bot on the one press of its card (Connect): the request and
 * its approval are written as the team edition's would be, `direct`, and nobody approved anything.
 * Every Bot may use every app the person turns on there, so the app was allowed by that, on its own.
 */
function givenWithoutAsking(event: AuditEvent): boolean {
  return (
    event.eventType === "app_access.approved" && event.payload?.direct === true
  );
}

/**
 * What came of a row. `storedNames` is false on the personal edition's Activity; see
 * {@link givenWithoutAsking}.
 */
/**
 * "Local computer access · Group: Sales", in the Permissions page's own words. Rows written before
 * they carried the title name the permission by its key.
 */
function permissionSubject(payload: Record<string, unknown>): string {
  const title =
    typeof payload.title === "string"
      ? payload.title
      : typeof payload.capability === "string"
        ? payload.capability
        : "";
  const scope =
    payload.scopeKind === "organization"
      ? "Everybody"
      : payload.scopeKind === "role"
        ? payload.scopeId === "admin"
          ? "Admins"
          : "Members"
        : payload.scopeKind === "group" && typeof payload.scopeId === "string"
          ? `Group: ${payload.scopeId}`
          : "";
  return [title, scope].filter(Boolean).join(" · ");
}

/** What a switch was set to, as the Permissions page says it: a group grants, the rest turn on or off. */
function permissionSetting(payload: Record<string, unknown>): string {
  if (payload.allowed === null) return "Set back to inherit";
  if (payload.allowed === false) return "Turned off";
  return payload.scopeKind === "group" ? "Granted" : "Turned on";
}

export function decisionText(event: AuditEvent, storedNames = true): string {
  const payload = event.payload ?? {};
  if (event.eventType === "capability.changed")
    return permissionSetting(payload);
  const outcome = outcomeOf(event);
  if (!storedNames && givenWithoutAsking(event)) return "Allowed automatically";
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
    notConnectedText(event) ??
    (legacy ? undefined : DECISIONS[event.eventType]) ??
    (outcome === "refused"
      ? "Blocked"
      : outcome === "did-not-happen"
        ? "Did not happen"
        : "Allowed")
  );
}

/**
 * The app a call needed and the asker had not connected, when that is why it did not happen.
 *
 * The server records the refusal as the Bot was given it, so `failure` opens with the
 * `[connect-app]{...}` marker the chat draws as a connect card. Read with the chat's own reader,
 * so the page and the card agree on what counts as one; nothing of the marker is drawn here.
 */
function connectPromptOf(event: AuditEvent): ConnectPrompt | null {
  const failure = event.payload?.failure;
  return typeof failure === "string" ? readConnectPrompt(failure) : null;
}

/**
 * Not "The server didn't answer": it answered, and the answer was that the app isn't connected.
 * Still the colour of something that did not happen, which it is.
 */
function notConnectedText(event: AuditEvent): string | undefined {
  const prompt = connectPromptOf(event);
  if (!prompt) return undefined;
  return prompt.reason === "reconnect"
    ? "No longer connected"
    : "Not connected";
}

/**
 * The line under "Not connected". Admin reads the refusal's own sentence, as its other reasons
 * read as recorded. A page anybody can open says it in its own words, because the recorded one
 * tells the Bot to "ask again" and this is a page, not a conversation.
 */
function notConnectedLine(prompt: ConnectPrompt, storedNames: boolean): string {
  if (storedNames && prompt.message) return prompt.message;
  if (prompt.reason === "reconnect")
    return `${prompt.title} is no longer connected. Reconnect it in Connections.`;
  if (prompt.reason === "shared")
    return `${prompt.title} uses a shared account nobody has connected yet. Ask an admin to connect it.`;
  return `${prompt.title} isn't connected. Connect it in Connections.`;
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
    const outcome = payload.outcome as
      | { behaviour?: unknown; source?: unknown }
      | undefined;
    // Allowed by the person's own answer earlier in the conversation, not by a rule.
    if (outcome?.source === "conversation" && outcome.behaviour === "allow")
      return "Allowed for this conversation";
    const behaviour = outcome?.behaviour;
    return typeof behaviour === "string"
      ? GATE_DECISIONS[behaviour]
      : undefined;
  }
  // An admin's guidance for auto-review, saved or taken away. Nothing was decided about an action.
  if (event.eventType === "approval.guidance_changed")
    return payload.after === null ? "Guidance removed" : "Guidance saved";
  return undefined;
}

/**
 * What a guidance save says under its decision: the words saved, and how the reading the admin saw
 * put them, or the words a removal took away.
 */
function guidanceLines(payload: Record<string, unknown>): string[] {
  const reading = (payload.reading ?? {}) as { summary?: unknown };
  if (typeof payload.after === "string")
    return [
      `Guidance: “${payload.after}”`,
      ...(typeof reading.summary === "string" && reading.summary
        ? [`Read as: ${reading.summary}`]
        : []),
    ];
  return typeof payload.before === "string"
    ? [`Removed: “${payload.before}”`]
    : [];
}

const PERSON_DECISIONS: Record<string, string> = {
  allow_once: "Allowed once by a person",
  allow_conversation: "Allowed for this conversation by a person",
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

/**
 * What a boundary save changed, one line each: the rules added and removed by their names, trial
 * mode switched, and the sentence a rule was written from when it was written in plain English.
 */
function policyChangeLines(payload: Record<string, unknown>): string[] {
  const named = (changes: unknown) =>
    Array.isArray(changes)
      ? changes
          .map((change: { name?: unknown; rule?: unknown }) =>
            typeof change?.name === "string" && change.name
              ? change.name
              : change?.rule,
          )
          .filter((name): name is string => typeof name === "string")
      : [];
  const mode = (payload.mode ?? {}) as { before?: unknown; after?: unknown };
  const authoring = (payload.authoring ?? {}) as { text?: unknown };
  return [
    ...named(payload.added).map((name) => `Added: ${name}`),
    ...named(payload.removed).map((name) => `Removed: ${name}`),
    ...(mode.before !== mode.after && typeof mode.after === "string"
      ? [mode.after === "dry-run" ? "Trial mode on" : "Trial mode off"]
      : []),
    ...(typeof authoring.text === "string"
      ? [`Written from: “${authoring.text}”`]
      : []),
  ];
}

/**
 * Why a component was not shown, for a page anybody can open. The stored reason is the one the Bot
 * is given, which names the component and its data by their ids and sends the person to an admin.
 */
const COMPONENT_REFUSALS: Record<string, string> = {
  "component.refused": "This Bot can't show it.",
  "component.function_refused": "It isn't allowed to read that data.",
};

type RecordedDecision = {
  allowed?: boolean;
  mode?: string;
  rule?: string | null;
  /** The rule's name on the Boundaries page. Absent on rows written before rows carried it. */
  ruleName?: string;
  carriedOut?: boolean;
};

function decisionOf(event: AuditEvent): RecordedDecision {
  return (event.payload?.decision ?? {}) as RecordedDecision;
}

/**
 * The policy rule that decided a row, as its CEL, for Admin only. Undefined for the default `true`
 * allow rule, which says nothing, and on a page anybody can open, where it is an admin's expression.
 */
function ruleExpression(
  event: AuditEvent,
  storedNames = true,
): string | undefined {
  const rule = decisionOf(event).rule;
  return storedNames && typeof rule === "string" && rule && rule !== "true"
    ? rule
    : undefined;
}

/**
 * The deciding rule by its name, where the row recorded one: "Stopped by: Bots may not visit social
 * media sites". A trial-mode refusal went ahead, so it says the rule would have stopped it.
 */
function ruleNameLine(event: AuditEvent, storedNames: boolean): string | null {
  const { allowed, mode, ruleName } = decisionOf(event);
  if (
    !ruleExpression(event, storedNames) ||
    typeof ruleName !== "string" ||
    !ruleName.trim()
  )
    return null;
  if (allowed !== false) return `Allowed by: ${ruleName}`;
  return mode === "dry-run"
    ? `Would be stopped by: ${ruleName}`
    : `Stopped by: ${ruleName}`;
}

/**
 * Every reason line under the decision, in the order the cell draws them. Admin (`storedNames`)
 * reads each as recorded; a page anybody can open says a component's refusal in words and leaves
 * out the policy rule that decided an action, which is an admin's expression. The rule's own CEL is
 * not one of these lines: the cell draws it last and clamped ({@link ruleExpression}).
 */
export function decisionDetails(
  event: AuditEvent,
  storedNames = true,
): string[] {
  const payload = event.payload ?? {};
  const decision = decisionOf(event);
  const failed = outcomeOf(event) === "did-not-happen";
  const lines: string[] = [];
  const refused =
    event.eventType === "computer.action_refused" ||
    event.eventType === "mcp.call_rejected"
      ? refusalLine(payload)
      : undefined;
  if (refused) lines.push(refused);
  else if (!storedNames && Object.hasOwn(COMPONENT_REFUSALS, event.eventType))
    lines.push(COMPONENT_REFUSALS[event.eventType] as string);
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
  const notConnected = connectPromptOf(event);
  if (failed && notConnected)
    lines.push(notConnectedLine(notConnected, storedNames));
  else if (failed && typeof payload.failure === "string")
    lines.push(payload.failure);
  /*
   * The two numbers the stall row is worth reading for. Without them every stalled turn looks the
   * same, and the difference between an endpoint that dies halfway through an answer and one that
   * never begins is the difference between a slow Bot and a dead one.
   */
  const silence =
    event.eventType === "agent.stream_stalled" ? silenceOf(payload) : null;
  if (silence) lines.push(silence);
  if (event.eventType === "computer.policy_changed")
    lines.push(...policyChangeLines(payload));
  /*
   * The rule that decided, by the name an admin gave it. A rule written from a sentence is a
   * thousand characters of CEL, and printed whole as a reason line it made a Blocked row hundreds of
   * pixels tall and named nothing. The expression is still drawn, clamped, under these lines.
   */
  const named = ruleNameLine(event, storedNames);
  if (named) lines.push(named);
  // Rules, a Bot's actions, a network allowlist and permissions saved from a description say
  // the sentence they were written from, as a boundary does.
  const ruleAuthoring = (payload.authoring ?? {}) as { text?: unknown };
  if (
    (event.eventType === "approval.rule_changed" ||
      event.eventType === "plugin.grants_changed" ||
      event.eventType === "network_policy.changed" ||
      event.eventType === "capability.changed") &&
    typeof ruleAuthoring.text === "string"
  )
    lines.push(`Written from: “${ruleAuthoring.text}”`);
  if (event.eventType === "approval.guidance_changed")
    lines.push(...guidanceLines(payload));
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
    whatText(event, false),
    // The stored name too, so a row is found by what the export and a collector call it.
    whatName(event),
    // Both ways a tool or an app is named, so either finds the row on either page.
    subjectText(event),
    subjectText(event, false),
    hostText(event),
    botText(event, nameFor),
    startedByText(event, nameFor, deployment),
    decisionText(event),
    decisionText(event, false),
    // Both ways a reason is said, as for the subject above.
    ...decisionDetails(event),
    ...decisionDetails(event, false),
    // The rule's CEL, clamped on screen and found whole.
    ruleExpression(event) ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

export function OnCell({
  event,
  storedNames = true,
}: {
  event: AuditEvent;
  /** Whether a tool or an app reads by its stored name, as Admin's do; see {@link subjectText}. */
  storedNames?: boolean;
}) {
  const payload = event.payload ?? {};
  const element = payload.element as Element;
  const subject = subjectText(event, storedNames);
  const host = hostText(event);
  /*
   * Named targets, tool counts, files and commands are identifiers and read in mono; a page element
   * is a label and does not, and nor is a tool or an app said in words.
   */
  const inWords = !storedNames && subjectWords(event) !== undefined;
  const mono =
    event.eventType === "mcp.tools_discovered" ||
    (NAMED_TARGETS.has(event.targetType) && !!event.targetId && !inWords) ||
    typeof payload.file === "string" ||
    typeof payload.command === "string" ||
    foldersOf(payload) !== undefined;
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
      ) : inWords ? (
        /*
         * A cap, as on the Decision lines: a few tools and their app make a long line, and drawn at
         * its own width it took the room Decision needs ("Boundary at start-up" broke at its hyphen).
         */
        <div className="mt-0.5 max-w-52 text-muted-foreground">{subject}</div>
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

export function DecisionCell({
  event,
  storedNames = true,
}: {
  event: AuditEvent;
  /** Whether reasons read as recorded, as Admin's do; see {@link decisionDetails}. */
  storedNames?: boolean;
}) {
  const outcome = outcomeOf(event);
  const expression = ruleExpression(event, storedNames);
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
        {decisionText(event, storedNames)}
      </span>
      {decisionDetails(event, storedNames).map((line) => (
        /*
         * A cap on the line, not a width. A fixed 22rem held the Decision column at least that wide,
         * and with the columns beside it pushed the table past a 1000px window. The table gives the
         * column what is left, the sentence wraps inside it, and a long unbroken word (a URL a
         * router quoted) breaks rather than widening the table.
         */
        <div className={DETAIL_LINE} key={line}>
          {line}
        </div>
      ))}
      {expression ? <RuleExpression expression={expression} /> : null}
    </>
  );
}

const DETAIL_LINE =
  "mt-0.5 max-w-[22rem] text-muted-foreground text-xs [overflow-wrap:anywhere]";

/**
 * The rule's CEL, two lines at most until somebody asks for the rest.
 *
 * A rule written from a sentence runs to a thousand characters, and drawn whole it made one Blocked
 * row taller than the window. Mono, like the other identifiers on a row, and muted, because the
 * rule's name above it is what a person reads; the expression is there to check it against. The
 * whole text stays in the row, so it is found by search and copied whole.
 *
 * The control appears only when the clamp hides something, measured on the drawn line: how much
 * fits in two lines depends on how wide the table left the column, which nothing here can know.
 */
function RuleExpression({ expression }: { expression: string }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const text = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const element = text.current;
    // Open, nothing is hidden to measure; the control stays, to close it again.
    if (!element || open) return;
    const measure = () =>
      setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  return (
    <>
      <div
        className={cn(
          DETAIL_LINE,
          "font-mono",
          // Text the clamp hides is still read out, so a screen reader hears the rule whole.
          !open && "line-clamp-2",
        )}
        id={id}
        ref={text}
      >
        {expression}
      </div>
      {cut ? (
        <button
          aria-controls={id}
          aria-expanded={open}
          className="mt-0.5 rounded-sm text-muted-foreground text-xs underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => setOpen((was) => !was)}
          type="button"
        >
          {open ? "Show less" : "Show full rule"}
        </button>
      ) : null}
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
  "computer.policy_changed": "Boundaries saved",
  // A draft for the admin to read. Not "Allowed": nothing was decided and nothing changed.
  "computer.policy_translated": "Drafted, not saved",
  // A question read into filters. Not "Allowed": nothing was decided, and nothing left the trail.
  "audit.asked": "Asked, nothing changed",
  "what_if.asked": "Asked, nothing changed",
  "what_if.checked": "Checked, nothing changed",
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
  "component.description_updated": "Description updated to this version's",
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
  // A draft for the admin to read, as a boundary's is. Nothing was decided and nothing changed.
  "approval.rules_translated": "Drafted, not saved",
  "plugin.grants_translated": "Drafted, not saved",
  "plugin.grants_changed": "Actions saved",
  // A draft network allowlist, as a boundary's is. Nothing was decided and nothing changed.
  "network_policy.translated": "Drafted, not saved",
  "capability.changes_translated": "Drafted, not saved",

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
