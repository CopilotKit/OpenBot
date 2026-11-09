import type { Message } from "@ag-ui/core";
import { GALLERY_COMPONENTS } from "@/lib/copilot/gallery-registry";

/**
 * What a turn told the person, as one line for the roster: the conversation's last line, and the
 * "<Bot> replied" notice a reply raises while OpenBot is out of sight.
 *
 * WORDS FIRST. The newest message of the turn that says something is the line, as it always was.
 *
 * A TURN CAN ANSWER WITH NOTHING BUT WHAT IT DREW. A trip budget, a chart, a record: the whole
 * answer is the component, and the message carrying it has no words. Read only for words, such a
 * turn told the roster nothing, so the conversation kept the person's own ask as its last line and
 * no notice was raised when it finished. So when a turn said nothing, its newest drawing is the line:
 * the title it was drawn with, or a sentence that says there is something to see.
 */
export type RunReply = {
  /** The message or call it came from, so a later run of the same turn says only what is new. */
  id: string;
  text: string;
};

/** The SDK's own tool for drawing an interface the Bot wrote; see `chat-messages.ts`. */
const GENERATE_SANDBOXED_UI = "generateSandboxedUi";

/** The line for a drawing whose title can't be read. */
export const DREW_SOMETHING = "Open the conversation to see what it drew.";

type ToolCall = NonNullable<
  Extract<Message, { role: "assistant" }>["toolCalls"]
>[number];

/**
 * The turn's newest words, or else its newest drawing. `before` is every message the conversation
 * held when the turn began; `authored` names the components this deployment's people wrote, which
 * a Bot draws as tools of those names.
 */
export function runReply(
  messages: readonly Message[],
  before: ReadonlySet<string>,
  authored: ReadonlySet<string> = new Set(),
): RunReply | null {
  const fresh = messages.filter(
    (message): message is Extract<Message, { role: "assistant" }> =>
      message.role === "assistant" && !before.has(message.id),
  );
  const said = fresh.findLast(
    (message) =>
      typeof message.content === "string" && message.content.trim() !== "",
  );
  if (said) return { id: said.id, text: String(said.content) };
  for (const message of [...fresh].reverse()) {
    const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const call of [...calls].reverse()) {
      const text = drawnLine(call, authored);
      if (text !== null) return { id: call.id, text };
    }
  }
  return null;
}

/** What one call drew, as a line, or null when the call drew nothing a person reads as a reply. */
function drawnLine(
  call: ToolCall | undefined,
  authored: ReadonlySet<string>,
): string | null {
  const name = call?.function?.name;
  if (typeof name !== "string") return null;
  const args = argumentsOf(call?.function?.arguments);
  if (name === GENERATE_SANDBOXED_UI)
    return headingOf(args.html) ?? DREW_SOMETHING;
  const component = GALLERY_COMPONENTS.find((each) => each.name === name);
  // A decision asks the person something. That turn is waiting on them, and says so itself.
  if (component && component.kind !== "decision")
    return titleOf(args) ?? component.title;
  if (authored.has(name)) return titleOf(args) ?? DREW_SOMETHING;
  return null;
}

function argumentsOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function oneLine(text: string | null | undefined): string | null {
  const line = text?.replace(/\s+/g, " ").trim();
  return line ? line : null;
}

function titleOf(args: Record<string, unknown>): string | null {
  return typeof args.title === "string" ? oneLine(args.title) : null;
}

/**
 * The first heading of an interface the Bot wrote, read from its markup without running any of it:
 * a document `DOMParser` makes is inert, so its scripts never run and its images never load.
 */
function headingOf(html: unknown): string | null {
  if (typeof html !== "string" || html.trim() === "") return null;
  const page = new DOMParser().parseFromString(html, "text/html");
  return (
    oneLine(page.querySelector("h1, h2, h3")?.textContent) ??
    oneLine(page.querySelector("title")?.textContent)
  );
}
