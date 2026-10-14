import type { VisibleChatItem } from "./chat-messages";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;

const labels: Record<string, string> = {
  computer_navigate: "Opened page",
  computer_read: "Read page",
  computer_snapshot: "Inspected page",
  computer_click: "Clicked on page",
  computer_type: "Filled in field",
  computer_key: "Pressed key",
  computer_scroll: "Scrolled page",
};

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
