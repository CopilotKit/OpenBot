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

/** Markdown read as the words a preview shows: no headings, emphasis, code marks or link targets. */
export function plainWords(markdown: string): string {
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
