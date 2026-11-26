/**
 * The gallery components a Bot draws in a conversation (a chart, a table, a card, a question), as the
 * phone reads them: from a message's `components` once it is read back, and from the run's TOOL_CALL
 * events while it is live (../live-run.ts). The web app's `app/src/components/gallery/` is where each
 * one's arguments are defined; ./cards.tsx and its neighbours draw them.
 *
 * Nothing here draws: it is the part the tests read.
 */
import type {
  ConversationMessage,
  DrawnComponent,
} from "../api/generated/model";

/** Components drawn as cards that only show something. */
export const SHOWN = [
  "showBarChart",
  "showPieChart",
  "showLineChart",
  "showAreaChart",
  "showProgress",
  "showRecord",
  "showMetrics",
  "showChecklist",
  "showNotice",
  "showTable",
  "showQuote",
  "showActivityReport",
] as const;

/** Components that asked the person something. The phone shows them, and what was answered. */
export const DECISIONS = ["askApproval", "askChoice", "askForm"] as const;

export type DrawnName = (typeof SHOWN)[number] | (typeof DECISIONS)[number];

const KNOWN = new Set<string>([...SHOWN, ...DECISIONS]);

/** Whether the phone draws a component by this name. Any other is skipped. */
export function isDrawn(name: unknown): name is DrawnName {
  return typeof name === "string" && KNOWN.has(name);
}

export function isDecision(name: string): boolean {
  return (DECISIONS as readonly string[]).includes(name);
}

/**
 * The components of a message the phone can draw, in the order the Bot drew them. A server older than
 * the field sends none; a name this app doesn't know, or an entry it can't read, is left out.
 */
export function drawable(
  message: Pick<ConversationMessage, "components">,
): DrawnComponent[] {
  const listed: unknown = message.components;
  if (!Array.isArray(listed)) return [];
  const seen = new Set<string>();
  const out: DrawnComponent[] = [];
  for (const entry of listed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { toolCallId, name } = entry as Record<string, unknown>;
    const given = (entry as Record<string, unknown>).arguments;
    if (typeof toolCallId !== "string" || !toolCallId || seen.has(toolCallId))
      continue;
    if (!isDrawn(name)) continue;
    seen.add(toolCallId);
    out.push({
      toolCallId,
      name,
      arguments:
        typeof given === "object" && given !== null && !Array.isArray(given)
          ? (given as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

/** What the person answered a decision with, as far as it can be read. */
export type Answer =
  | {
      kind: "approval";
      decision: "approved" | "declined" | "other";
      note?: string;
    }
  | { kind: "choice"; choice?: string; answer?: string }
  | { kind: "form"; values: Record<string, string | number> };

/**
 * An answer from a decision's result: the JSON text a tool result carries, or the object itself. The
 * shapes are the web app's (`decisions.tsx`, `form.tsx`). Anything else is no answer.
 */
export function answerOf(result: unknown): Answer | undefined {
  let read: unknown = result;
  if (typeof result === "string") {
    try {
      read = JSON.parse(result);
    } catch {
      return undefined;
    }
  }
  if (typeof read !== "object" || read === null || Array.isArray(read))
    return undefined;
  const fields = read as Record<string, unknown>;
  const decision = fields.decision;
  if (
    decision === "approved" ||
    decision === "declined" ||
    decision === "other"
  )
    return typeof fields.note === "string" && fields.note
      ? { kind: "approval", decision, note: fields.note }
      : { kind: "approval", decision };
  if (typeof fields.choice === "string")
    return { kind: "choice", choice: fields.choice };
  if (typeof fields.answer === "string")
    return { kind: "choice", answer: fields.answer };
  if (
    fields.status === "submitted" &&
    typeof fields.values === "object" &&
    fields.values !== null
  ) {
    const values: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(fields.values)) {
      if (typeof value === "string" || typeof value === "number")
        values[key] = value;
    }
    return { kind: "form", values };
  }
  return undefined;
}

/**
 * The answers a conversation's messages say, by tool call: a component's own `result` when a server
 * sends one, else the tool lines that follow the Bot's message, read in order against the decisions it
 * asked. `oldestFirst` is the conversation in the order it was said.
 */
export function answersIn(
  oldestFirst: readonly ConversationMessage[],
): Map<string, Answer> {
  const answers = new Map<string, Answer>();
  for (let index = 0; index < oldestFirst.length; index += 1) {
    const message = oldestFirst[index] as ConversationMessage;
    if (message.role !== "bot") continue;
    const waiting: string[] = [];
    for (const component of drawable(message)) {
      if (!isDecision(component.name)) continue;
      // Not in the spec: read only when a server sends it.
      const raw = (message.components ?? []).find(
        (entry) => entry?.toolCallId === component.toolCallId,
      ) as { result?: unknown } | undefined;
      const answer = answerOf(raw?.result);
      if (answer) answers.set(component.toolCallId, answer);
      else waiting.push(component.toolCallId);
    }
    // The tool lines right after the Bot's message, up to whatever is said next.
    for (
      let next = index + 1;
      waiting.length > 0 && next < oldestFirst.length;
      next += 1
    ) {
      const line = oldestFirst[next] as ConversationMessage;
      if (line.role !== "tool") break;
      const answer = answerOf(line.text);
      if (answer) answers.set(waiting.shift() as string, answer);
    }
  }
  return answers;
}

/** Each item of a list with a key by where it arrived: a label may still be being written. */
export function byPosition<T>(items: readonly T[]): { item: T; key: string }[] {
  return items.map((item, at) => ({ item, key: `at-${at}` }));
}

/** A list the Bot sent, or none. */
export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
/** An object the Bot sent, or an empty one. */
export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export type Cell = string | number;

/**
 * A table (showTable) as far as it can be drawn: whole, or still arriving with its last row short of cells (set aside,
 * `held`), or `null` while what has arrived can't be drawn yet. Once its arguments are final, a table that still isn't
 * whole (no columns, the same column twice, a row short of cells) has `failed`.
 */
export function readTable(
  args: Record<string, unknown>,
  arriving: boolean,
):
  | { columns: string[]; rows: Cell[][]; held: boolean }
  | { failed: true }
  | null {
  const columns = list(args.columns).filter(
    (column): column is string => typeof column === "string",
  );
  const rows = list(args.rows).map((row) =>
    list(record(row).cells).filter(
      (cell): cell is Cell =>
        typeof cell === "string" || typeof cell === "number",
    ),
  );
  let held = false;
  const last = rows.at(-1);
  if (arriving && last && last.length < columns.length) {
    rows.pop();
    held = true;
  }
  const whole =
    columns.length > 0 &&
    new Set(columns).size === columns.length &&
    rows.every((row) => row.length === columns.length);
  if (whole) return { columns, rows, held };
  return arriving ? null : { failed: true };
}
