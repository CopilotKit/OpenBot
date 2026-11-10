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
/**
 * The runtime's tool for drawing an A2UI interface from the catalog in `lib/copilot/a2ui.ts`. The
 * runtime answers it itself, so a turn that draws with it is one run with no words.
 */
const RENDER_UI = "render_ui";

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
  if (name === RENDER_UI) return surfaceLine(args.operations);
  const component = GALLERY_COMPONENTS.find((each) => each.name === name);
  // A decision asks the person something. That turn is waiting on them, and says so itself.
  if (component && component.kind !== "decision")
    return titleOf(args) ?? component.title;
  if (authored.has(name)) return titleOf(args) ?? DREW_SOMETHING;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function argumentsOf(raw: unknown): Record<string, unknown> {
  const args = typeof raw === "string" ? parsed(raw) : undefined;
  return isRecord(args) ? args : {};
}

/**
 * What a `render_ui` call drew, as a line: the surface's title, or its first words, or the sentence
 * that says there is something to see. Null when the call drew nothing, such as one that only runs
 * an app function.
 *
 * The components come inline in `createSurface` or in `updateComponents`, and are read in the order
 * they are shown, from `root` down. A model sometimes sends the operations as one JSON string, which
 * the runtime reads too.
 */
function surfaceLine(raw: unknown): string | null {
  const operations = typeof raw === "string" ? parsed(raw) : raw;
  if (!Array.isArray(operations)) return null;
  const drawing = operations
    .filter(isRecord)
    .flatMap((operation) =>
      [operation.createSurface, operation.updateComponents].filter(isRecord),
    );
  if (drawing.length === 0) return null;
  const components = shownOrder(
    drawing.flatMap((part) =>
      Array.isArray(part.components) ? part.components.filter(isRecord) : [],
    ),
  );
  const words = (component: Record<string, unknown>) =>
    typeof component.text === "string" ? firstLine(component.text) : null;
  const heading = components
    .map((component) =>
      component.component === "Title"
        ? words(component)
        : typeof component.title === "string"
          ? oneLine(component.title)
          : typeof component.text === "string" && /^\s*#/.test(component.text)
            ? words(component)
            : null,
    )
    .find((line) => line !== null);
  const text = components
    .filter((component) => component.component === "Text")
    .map(words)
    .find((line) => line !== null);
  return heading ?? text ?? DREW_SOMETHING;
}

/** The components from `root` down, each child in its place, then any that nothing places. */
function shownOrder(
  components: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const byId = new Map(
    components
      .filter((component) => typeof component.id === "string")
      .map((component) => [component.id as string, component]),
  );
  const shown: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();
  const visit = (id: unknown) => {
    const component = typeof id === "string" ? byId.get(id) : undefined;
    if (!component || seen.has(component)) return;
    seen.add(component);
    shown.push(component);
    visit(component.child);
    if (Array.isArray(component.children)) component.children.forEach(visit);
    if (Array.isArray(component.tabs))
      for (const tab of component.tabs) if (isRecord(tab)) visit(tab.child);
  };
  visit("root");
  return [...shown, ...components.filter((component) => !seen.has(component))];
}

/** A text's first line, without the marks that make it a Markdown heading. */
function firstLine(text: string): string | null {
  const line = text
    .trim()
    .split("\n")[0]
    ?.replace(/^#{1,6}\s+/, "")
    .replace(/\*\*/g, "");
  return oneLine(line);
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
