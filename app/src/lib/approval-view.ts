import type { ApprovalRequest } from "./approvals";
import { connectorName, humanise, readToolName } from "./plugins/tool-name";

/**
 * How an approval request reads on its card: a title in plain words, the app it is for, the fields a
 * person checks before saying yes (To, Subject), and the body. Built only from what the request
 * carries; anything it cannot place stays in the card's Details.
 */
export type ApprovalView = {
  title: string;
  app: string | null;
  kind: "mail" | "browser" | "command" | "other";
  fields: { label: string; value: string }[];
  body: string | null;
};

const RECIPIENT =
  /^(to|recipients?|recipient_?emails?|to_?emails?|to_?address(es)?|email_?to|send_?to)$/i;
const SUBJECT = /^(subject|title)$/i;
const BODY = /^(body|text|message|content|message_?body|html|plain_?text)$/i;
/** Plumbing the person cannot act on: page references, ids and the content's digest. */
const HIDDEN =
  /^(ref|snapshot_?id|element_?ref|id|thread_?id|tool_?call_?id|bot_?id|actor_?id|owner_?user_?id|grant_?id|content_?digest)$/i;
/** A command on the person's computer also names its own kind and the folder's write switch. */
const HOST_HIDDEN = /^(kind|writable)$/i;
const MAX_FIELDS = 4;

/** The ref the server's private-share check asks under (server/src/proactive/private-share.ts). */
const PRIVATE_SHARE = "openbot/share_private_information";
/** Refs OpenBot itself owns, which name no app. */
const OWN_PREFIXES = new Set(["host", "bot", "openbot"]);
/** OpenBot's own tools, in words somebody chose. */
const OWN_TITLES: Record<string, string> = {
  "bot/message_bot": "Ask another Bot",
};

const words = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

const sentence = (parts: string[]) => {
  const text = parts.join(" ");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
};

const display = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string")
  )
    return value.join(", ");
  return null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The app before the `/` of an app's tool ref (`gmail/send_email`), the prefix OpenBot's own tools
 * carry (`host/`, `bot/`), or null for the computer's. A rule may write an app's ref as
 * `mcp/gmail/send_email`, and that `mcp/` names no app.
 */
function serverOf(toolRef: string): string | null {
  const ref = toolRef.replace(/^mcp\//, "");
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : null;
}

/**
 * A send to other people, as the private-share check asks about it.
 *
 * The check asks before the send itself, so its request carries the audience as `<server id>:
 * <recipients>` and a preview of what goes out, not the tool's own arguments. Read as the message
 * it is: the app, who it goes to, and what it says. The content digest is how the server matches a
 * later send to this answer; it means nothing to the person and is left out.
 */
function describeShare(args: Record<string, unknown>): ApprovalView {
  const audience = display(args.audience) ?? "";
  const split = audience.indexOf(": ");
  const server = split > 0 ? audience.slice(0, split) : "";
  const to = split > 0 ? audience.slice(split + 2) : audience;
  // With no recipients in its arguments the check names the tool instead, which is nobody.
  const named = to && !(server && to.startsWith(`${server}/`));
  const mail = /mail|outlook|inbox/i.test(server);
  return {
    title: mail ? "Send email" : "Send a message",
    app: server ? connectorName(server) : null,
    kind: mail ? "mail" : "other",
    fields: named ? [{ label: "To", value: to }] : [],
    body: display(args.preview),
  };
}

/**
 * Where an action happens, as a person reads it, or null where the card already says it: the site a
 * browser step acts on, the folder a command runs in. The scope is the server's matching key, so it
 * is shown only where it is a place. An app's own id, a share's recipients and the Bot a hand-off
 * goes to are already on the card as the app and the To or Bot field.
 */
export function approvalPlace(
  request: Pick<ApprovalRequest, "action">,
): string | null {
  const { toolRef, scope, target } = request.action;
  if (toolRef === PRIVATE_SHARE) return null;
  const server = serverOf(toolRef);
  if (server === "host") return display(record(target)?.displayName);
  if (server === "bot" || scope === server) return null;
  // The computer's own words for "no page" and "its workspace" are no place a person names.
  if (!scope || ["*", "browser", "workspace"].includes(scope)) return null;
  return scope;
}

/** Whether the person was asked about this request, rather than a saved rule deciding it. */
export function personWasAsked(
  request: Pick<ApprovalRequest, "action">,
): boolean {
  return (
    Boolean(request.action.policy) || request.action.toolRef === PRIVATE_SHARE
  );
}

export function describeApproval(
  request: Pick<ApprovalRequest, "action">,
): ApprovalView {
  const { toolRef } = request.action;
  const args = record(request.action.args);
  if (toolRef === PRIVATE_SHARE && args) return describeShare(args);
  const server = serverOf(toolRef);
  const tool = server
    ? toolRef.replace(/^mcp\//, "").slice(server.length + 1)
    : toolRef;
  /*
   * An app's tool is named the way its line in the conversation names it ("Send your email"), with
   * the app beside it, so the card and the step above it say the same thing.
   */
  const ownTitle = OWN_TITLES[toolRef];
  const title =
    ownTitle ??
    (server && !OWN_PREFIXES.has(server)
      ? readToolName(`mcp__${server}__${tool}`, "plain").label
      : server
        ? humanise(tool)
        : sentence(words(tool.replace(/^computer_/, ""))));
  const app =
    server && !OWN_PREFIXES.has(server) ? connectorName(server) : null;

  const kind: ApprovalView["kind"] = /^computer_/.test(tool)
    ? "browser"
    : server === "host"
      ? "command"
      : server !== "bot" && /mail|message|send|reply|forward/i.test(tool)
        ? "mail"
        : "other";

  const fields: ApprovalView["fields"] = [];
  let body: string | null = null;
  if (args) {
    const entries = Object.entries(args);
    const hidden = (key: string) =>
      HIDDEN.test(key) || (server === "host" && HOST_HIDDEN.test(key));
    // The first key matching, under `label` or, without one, under its own name.
    const pick = (pattern: RegExp, label?: string) => {
      for (const [key, value] of entries) {
        if (!pattern.test(key)) continue;
        const shown = display(value);
        if (shown)
          fields.push({ label: label ?? sentence(words(key)), value: shown });
        return;
      }
    };
    pick(RECIPIENT, "To");
    pick(/^cc$/i, "Cc");
    pick(/^bcc$/i, "Bcc");
    pick(SUBJECT);
    for (const [key, value] of entries) {
      if (!BODY.test(key)) continue;
      body = display(value);
      if (body) break;
    }
    for (const [key, value] of entries) {
      if (fields.length >= MAX_FIELDS) break;
      if ([RECIPIENT, SUBJECT, BODY].some((test) => test.test(key))) continue;
      if (hidden(key) || /^b?cc$/i.test(key)) continue;
      const shown = display(value);
      if (shown) fields.push({ label: sentence(words(key)), value: shown });
    }
  }

  return { title: title || toolRef, app, kind, fields, body };
}

/** Who decided, in the person's words, for the line under a decided card. */
export function decisionReceipt(
  request: Pick<ApprovalRequest, "decision">,
): string | null {
  switch (request.decision) {
    case "allow_once":
      return "Allowed once by you";
    case "allow_always":
      return "Always allowed here by you";
    case "deny":
      return "Declined by you";
    case "handled":
      return "You did it yourself";
    default:
      return null;
  }
}

/** A pill's colour: the four status colours, or neutral for an outcome that is nobody's problem. */
export type OutcomeTone = "done" | "working" | "needs" | "problem" | "neutral";

/**
 * How the action ended, as the pill on a decided card shows it. Nothing while it waits.
 *
 * The person's own decline comes first, whatever the status: once the Bot has been told, the server
 * finishes a declined request with the decline as its error, and that is not the action failing.
 */
export function approvalOutcome(
  request: Pick<ApprovalRequest, "status" | "result" | "action" | "decision">,
): { label: string; tone: OutcomeTone } | null {
  if (request.status === "pending") return null;
  if (request.decision === "deny")
    return { label: "Declined", tone: "neutral" };
  switch (request.status) {
    case "completed":
      if (request.result?.error) return { label: "Didn't work", tone: "needs" };
      // A share the person allowed sends nothing itself: the Bot is told to send it again.
      if (request.action.toolRef === PRIVATE_SHARE)
        return { label: "Allowed", tone: "done" };
      return {
        label:
          request.decision !== "handled" &&
          describeApproval(request).kind === "mail" &&
          /send|reply|forward/i.test(request.action.toolRef)
            ? "Sent"
            : "Done",
        tone: "done",
      };
    case "denied":
      return { label: "Not done", tone: "neutral" };
    case "approved":
    case "consumed":
      return { label: "Allowed", tone: "working" };
    default:
      return null;
  }
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** "2:59 PM" today, "Oct 20" before that: the stamp on a decided card. */
export function clockTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  return at.toDateString() === now.toDateString()
    ? timeFormat.format(at)
    : dayFormat.format(at);
}
