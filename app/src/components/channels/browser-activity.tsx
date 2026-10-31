import {
  BROWSER_STEP_DONE as labels,
  BROWSER_STEP_PLAIN as plainLabels,
} from "@/lib/computers/step-names";
import { toolResultHeldBack } from "@/lib/plugins/tool-result";
import type { VisibleChatItem } from "./chat-messages";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;

/** Whether a tool call is one of the browser steps a tool group draws with its page link. */
export function isBrowserStep(item: BrowserStep): boolean {
  return Object.hasOwn(labels, item.toolCall.function.name);
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
    label: labels[step.toolCall.function.name],
    plain: plainLabels[step.toolCall.function.name],
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

/**
 * How a browser step came out, from its result alone.
 *
 * ONE READING FOR BOTH PLACES A STEP IS SHOWN. The conversation's tool line (`stepDetails`) and the
 * computer pane's step log (`step-log.tsx`) both read a step here, so a click the person declined
 * never reads as done in one of them and declined in the other.
 *
 * A step the person held back is read before any of the browser's own fields, with
 * `toolResultHeldBack`: declined on its card, or not asked again because the same request was still
 * waiting (`alreadyWaiting`). The server says either in words for the model, sometimes inside the
 * browser's JSON, and it would otherwise read as a step that worked or one that failed. `pending` is
 * a step with no result yet, or only the note that it went to its approval card. Whether that is
 * running, waiting for the person or cut off is for the caller to say, from the turn and the
 * approvals inbox, and so is whether a request `alreadyWaiting` repeated is still waiting.
 */
export type BrowserOutcome =
  | "pending"
  | "declined"
  | "alreadyWaiting"
  | "stopped"
  | "blocked"
  | "notYet"
  | "failed"
  | "done";

export function browserOutcome(step: BrowserStep): BrowserOutcome {
  if (step.result === undefined) return "pending";
  const result = objectOf(step.result);
  if (result.waiting === true) return "pending";
  const heldBack = toolResultHeldBack(step.result);
  if (heldBack) return heldBack;
  // Cut off, like a call that never got its result: nothing went wrong with the page.
  if (result.stopped === true) return "stopped";
  if (result.refused === true) return "blocked";
  if (result.ok === false && result.starting === true) return "notYet";
  return browserStepDetails(step).failed ? "failed" : "done";
}
