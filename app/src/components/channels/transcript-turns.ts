import { readFiring } from "@/lib/channels/routine-firing";
import type { TranscriptItem } from "./tool-activity";

/**
 * Whether a text item is the person actually sending something, as opposed to a routine firing that
 * merely arrived wearing `role: "user"`.
 *
 * A FIRING IS NOT THE PERSON SPEAKING — `TranscriptMessage` already knows that and draws it as
 * `RoutineFiring` rather than as their bubble, via the same `readFiring` check used here. The scroll
 * machinery was the one place left that had not caught up: it smooth-scrolled and anchored on
 * `role === "user"` alone, so a routine firing while somebody was reading back through the channel
 * yanked their viewport to the bottom as though they had just typed and sent something. They hadn't;
 * the schedule had. Exported so this can be checked without mounting anything.
 */
export function isPersonSentMessage(
  role: "user" | "assistant",
  text: string,
): boolean {
  return role === "user" && readFiring(text) === null;
}

/** One mark on the rail: the row it jumps to, and what its preview says. */
export type Turn = {
  /** The id of the turn's first row, which is also its `data-message-id`. */
  id: string;
  /** That row's place in the transcript's items, so a jump knows which page to draw. */
  index: number;
  prompt: string;
  /** The first thing the Bot said back, or "" while it hasn't. */
  reply: string;
};

function isPersons(item: TranscriptItem): boolean {
  return (
    (item.kind === "text" && isPersonSentMessage(item.role, item.text)) ||
    item.kind === "attachments"
  );
}

/*
 * The turns are rebuilt on every streamed chunk, and stripping every message again each time was the
 * per-token cost the rest of the transcript avoids. Each text is stripped once; only the reply still
 * growing is new on a chunk. Cleared whole when it grows large, which only a very long session reaches.
 */
const plainCache = new Map<string, string>();
const PLAIN_CACHE_SIZE = 1000;

/** Markdown read as the words a preview shows: no headings, emphasis, code marks or link targets. */
export function plainWords(markdown: string): string {
  const cached = plainCache.get(markdown);
  if (cached !== undefined) return cached;
  if (plainCache.size >= PLAIN_CACHE_SIZE) plainCache.clear();
  const plain = strip(markdown);
  plainCache.set(markdown, plain);
  return plain;
}

function strip(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The conversation's turns, oldest first. A turn starts where the person sent something — text, or
 * files, which arrive as their own row beside the caption and are one turn with it — and runs until
 * they send again. A routine firing starts none: nobody typed it.
 */
export function turnsOf(items: readonly TranscriptItem[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let files = 0;
  let previousWasPersons = false;

  items.forEach((item, index) => {
    const persons = isPersons(item);
    if (persons && !previousWasPersons) {
      current = { id: item.id, index, prompt: "", reply: "" };
      files = 0;
      turns.push(current);
    }
    previousWasPersons = persons;
    if (current === null) return;

    if (persons) {
      if (item.kind === "text") {
        current.prompt = plainWords(item.text);
      } else if (item.kind === "attachments") {
        files += item.attachments.length;
        if (current.prompt === "") {
          current.prompt = files === 1 ? "1 file" : `${files} files`;
        }
      }
    } else if (
      item.kind === "text" &&
      item.role === "assistant" &&
      current.reply === ""
    ) {
      current.reply = plainWords(item.text);
    }
  });

  return turns;
}

/** How close to the end, in pixels, counts as being at the end of the conversation. */
export const AT_END_PX = 8;

/**
 * Which turn is being read, from where each drawn turn's first row starts relative to the view: the
 * last to start above `line` (a third of the way down), or the first drawn when none has. At the end
 * of the conversation it is the last turn, which may be too short to reach the line: opened at the
 * bottom, a short last answer starts low on the screen, and the turn before it would win.
 */
export function currentTurn(
  rows: readonly { id: string; top: number }[],
  line: number,
  atEnd: boolean,
): string | null {
  if (atEnd) return rows.at(-1)?.id ?? null;
  let current: string | null = null;
  for (const row of rows) {
    if (current !== null && row.top > line) break;
    current = row.id;
  }
  return current;
}
