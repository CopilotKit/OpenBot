import { ownToolLabel } from "@openbot/shared/tool-name";
import type { VisibleChatItem } from "./chat-messages";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;

/** The browser steps, named in the words every other line uses for them (`shared/tool-name.ts`). */
const BROWSER_STEPS: ReadonlySet<string> = new Set([
  "computer_navigate",
  "computer_read",
  "computer_snapshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
]);

/** Whether a tool call is one of the browser steps a tool group draws with its page link. */
export function isBrowserStep(item: BrowserStep): boolean {
  return BROWSER_STEPS.has(item.toolCall.function.name);
}

function objectOf(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Whether the computer turned a browser step away until the Bot looked at the page again.
 *
 * After a person hands the browser back, the computer asks the Bot for a fresh snapshot before it
 * acts on the page. That answer is an instruction for the Bot: nothing happened on the page, and the
 * Bot takes the snapshot and acts again on its own. Drawn, it put the instruction in red under a
 * turn that went on to work, so the transcript leaves it out.
 *
 * Not a handback whose closing snapshot failed. That result also says `snapshotRequired`, carries
 * the handoff's status, and is a real failure the person may need to resume.
 */
export function awaitingFreshLook(step: BrowserStep): boolean {
  if (!isBrowserStep(step)) return false;
  const result = objectOf(step.result);
  return (
    result.ok === false &&
    result.snapshotRequired === true &&
    result.handoffStatus === undefined
  );
}

export function browserStepDetails(step: BrowserStep) {
  const result = objectOf(step.result);
  const args = objectOf(step.toolCall.function.arguments);
  const navigation = step.toolCall.function.name === "computer_navigate";
  const rawUrl = navigation ? (result.url ?? args.url) : undefined;
  let url: URL | undefined;
  try {
    if (typeof rawUrl === "string") {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        url = parsed;
    }
  } catch {
    /* A partial streaming URL is not a link yet. */
  }
  const failed =
    result.ok === false ||
    result.refused === true ||
    step.result?.startsWith("Error:") === true;
  return {
    label: ownToolLabel(step.toolCall.function.name) ?? undefined,
    href: url?.href,
    title:
      navigation && typeof result.title === "string" && result.title.trim()
        ? result.title
        : url?.hostname,
    failed,
    reason: typeof result.reason === "string" ? result.reason : undefined,
    visited: navigation && result.ok === true,
    pending: step.result === undefined,
  };
}
