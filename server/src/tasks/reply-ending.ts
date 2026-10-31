/*
 * How a Bot's reply ends, read for Tasks: the line a task shows as its next step, and whether the
 * reply finished by asking the person something. Words only, so it reads the same wherever the
 * reply came from.
 */

/** How long a kept reply tail may be. A next step is one line on Tasks. */
const REPLY_TAIL_MAX = 240;
/** A last sentence shorter than this is kept with the one before it. */
const SHORT_SENTENCE = 20;

/** A paragraph that is a list: every line of it is an item. */
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+/;
/** A paragraph that is something the Bot drafted for the person, not what it says to them. */
const DRAFT =
  /^\s*(?:>|```|["“'‘]|\*{0,2}_{0,2}(?:draft|subject|to|dear|hi|hello)\b[^\n]{0,40}?:)/i;
/** What can trail a question and still leave it one: closing quotes, brackets, emoji, spaces. */
const TRAILING = /(?:[\s"”'’)\]}»\p{Extended_Pictographic}]|\uFE0F|\u200D)+$/u;

/** Whether a sentence asks something, once what trails its question mark is set aside. */
const asksIn = (sentence: string) =>
  sentence.replace(TRAILING, "").endsWith("?");

const plain = (line: string) =>
  line
    .replace(/^\s*(?:[-*+>•]|#{1,6}|\d+[.)])\s+/, "")
    .replace(/[*_`]+/g, "")
    .trim();

/**
 * A closing sentence that only says nothing waits on the person. It reports no work, and it would
 * stand on Tasks as the next step of a finished task, so it is set aside. Matched whole, so a
 * finding such as "Nothing in your inbox needs a reply from you" is kept.
 */
const NOTHING_WAITING = [
  /^(?:there(?:'s|’s| is) )?nothing(?: else)?(?: is| 's|’s)? (?:waiting on|waiting for|needed from|required from|needs|pending (?:on|from)) you(?: right now| now| for now| at the moment)?[.!]?$/i,
  /^no (?:further |other )?(?:action|input) (?:is )?(?:needed|required)(?: from you)?(?: right now| now| for now)?[.!]?$/i,
  /^you don['’]t need to do anything(?: else)?(?: right now| now| for now)?[.!]?$/i,
];
const waitsOnNothing = (sentence: string) =>
  NOTHING_WAITING.some((pattern) => pattern.test(sentence));

/**
 * What the Bot says to the person in a reply, paragraph by paragraph, as sentences. Lists and drafts
 * are what it prepared, not what it says, so they are set aside, and so is a sentence that only says
 * nothing waits on them. With nothing else to read, the reply's last paragraph is kept, less any
 * such sentence.
 */
function spokenParagraphs(reply: string | null | undefined): {
  paragraphs: string[][];
  spoken: boolean;
} {
  const paragraphs = (reply ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => /[\p{L}\p{N}]/u.test(paragraph));
  const spoken = paragraphs
    .filter((paragraph) => {
      const lines = paragraph.split("\n").filter((line) => line.trim());
      return !(
        lines.every((line) => LIST_ITEM.test(line)) || DRAFT.test(paragraph)
      );
    })
    .map((paragraph) =>
      sentencesOf(paragraph).filter((s) => !waitsOnNothing(s)),
    )
    .filter((sentences) => sentences.length > 0);
  if (spoken.length) return { paragraphs: spoken, spoken: true };
  const last = sentencesOf(paragraphs.at(-1)).filter(
    (sentence) => !waitsOnNothing(sentence),
  );
  return { paragraphs: last.length ? [last] : [], spoken: false };
}

function sentencesOf(paragraph: string | undefined): string[] {
  return (paragraph ?? "")
    .split("\n")
    .map(plain)
    .flatMap((line) => line.split(/(?<=[.!?][\s"”'’)\]]*)\s+(?=\S)/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
}

/**
 * How a reply ends, for Tasks: the sentence to show as the next step, and whether it asks the
 * person something.
 *
 * A Bot ends a turn on what comes next, in the last paragraph it writes to the person
 * (`spokenParagraphs`). Within that last paragraph its last question is the next step, even with a
 * remark after it; without one, its last sentence is. A short closing sentence keeps the one before
 * it, so "Do you want me to?" never stands alone. Null when there is nothing to say.
 */
export function replyEnding(reply: string | null | undefined): {
  tail: string | null;
  asks: boolean;
} {
  const { paragraphs, spoken } = spokenParagraphs(reply);
  const sentences = paragraphs.at(-1) ?? [];
  const question = sentences.findLastIndex(asksIn);
  const at = question >= 0 ? question : sentences.length - 1;
  const chosen = sentences[at];
  if (!chosen) return { tail: null, asks: false };
  // A paragraph of its own still leans on the paragraph before it.
  const before = sentences[at - 1] ?? paragraphs.at(-2)?.at(-1);
  const sentence =
    chosen.length < SHORT_SENTENCE && before ? `${before} ${chosen}` : chosen;
  return {
    tail:
      sentence.length > REPLY_TAIL_MAX
        ? `${Array.from(sentence)
            .slice(0, REPLY_TAIL_MAX - 1)
            .join("")}…`
        : sentence,
    asks: spoken && question >= 0,
  };
}

/** The sentence `replyEnding` would show, alone. */
export function replyTail(reply: string | null | undefined): string | null {
  return replyEnding(reply).tail;
}
