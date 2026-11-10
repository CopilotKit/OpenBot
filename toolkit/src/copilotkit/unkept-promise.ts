/**
 * Whether an answer ends on a promise of work instead of the work.
 *
 * FOUND ON A TEAMMATE'S ROUTINE. About twenty lookups across Linear and Notion; the Bot fanned out,
 * then ended its turn "I'll fetch the rest now" with no call after it, and the run was over. Every
 * model does this sometimes (Anthropic documents it: the model "describes what it would do next
 * instead of doing it"), and prompt wording alone roughly halves it, so the harness catches the rest:
 * the check Claude Code's Stop hooks make. Kept deliberately plain: a first-person announcement of an
 * action in the answer's last two sentences, or anywhere with "now" or "next" on it, that is not a
 * question, not waiting on the person and not deferred to another day.
 *
 * A false positive costs one model call, because the nudge it triggers offers the way out ("or
 * finish with the result and what is missing"). A miss costs the run. So the bias is toward firing.
 */

const APOSTROPHE = "['’]";

/** "I'll", "Let me", "Next, I will", "I'm going to", and the rest of the ways a model announces. */
const ANNOUNCES = new RegExp(
  [
    `\\bI${APOSTROPHE}ll\\b`,
    "\\bI will\\b",
    "\\bI shall\\b",
    `\\bI${APOSTROPHE}m (?:now )?(?:going|about) to\\b`,
    "\\bI am (?:now )?(?:going|about) to\\b",
    "\\blet me\\b",
    `\\blet${APOSTROPHE}s\\b`,
  ].join("|"),
  "gi",
);

/** Filler a model puts between the announcement and its verb. */
const FILLER =
  /^(?:\s+(?:now|next|then|just|quickly|also|first|go ahead and|go and|go|start by|continue by|proceed to|try to))*\s+(\p{L}+)/iu;

/**
 * What follows "I'll" or "let me" without being an action this run could take: "let me know",
 * "I'll be here", "I'll keep an eye on it", "I'll let you know", "let's see".
 */
const NOT_ACTIONS = new Set([
  "know",
  "be",
  "need",
  "wait",
  "keep",
  "remember",
  "leave",
  "stop",
  "assume",
  "note",
  "let",
  "hold",
  "stand",
  "see",
  "say",
  "mention",
  "admit",
  "repeat",
]);

/**
 * Doing it now, without the "I", as the sentence's first words: "Fetching the rest now.", "Now
 * checking Notion." Only first, because "the sync is running now" is a report, not a promise.
 */
const GERUND =
  "(?:fetching|checking|pulling|looking up|searching|reading|retrying|grabbing|loading|retrieving|querying|doing|starting|continuing|moving on|proceeding|opening|compiling|gathering|collecting)";
const UNDER_WAY = new RegExp(
  `^(?:now,?\\s+${GERUND}\\b|${GERUND}\\b[^.!?\\n]{0,80}?\\b(?:now|next)\\b)`,
  "i",
);

/** Waiting on the person, or for another day, and so not a promise this run broke. */
const DEFERRED =
  /\b(?:once you|when you|if you|after you|as soon as you|until you|unless you|tomorrow|next (?:run|time|week|month|firing|cycle|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|later today|on the next)\b/i;

/** Said about this run: the step is still to come. */
const IMMEDIATE =
  /\b(?:now|next|right away|immediately|in a moment|shortly|straight away)\b/i;

/**
 * The sentence in `text` that promises work the run did not do, or undefined.
 *
 * Only for an answer that made no tool call: the caller decides that. An answer ending on a question
 * to the person is theirs to answer, not a promise, and is never one here.
 */
export function unkeptPromise(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.endsWith("?")) return undefined;
  const paragraphs = trimmed.split(/\n\s*\n/);
  // The last two sentences: where a run that stopped short says what it was about to do.
  for (const sentence of sentences(paragraphs.at(-1) ?? "").slice(-2))
    if (promises(sentence)) return sentence;
  for (const sentence of sentences(trimmed))
    if (IMMEDIATE.test(sentence) && promises(sentence)) return sentence;
  return undefined;
}

function promises(sentence: string): boolean {
  // A question is the person's to answer; a colon introduces what follows it, which is the work.
  if (/[?:]$/.test(sentence) || DEFERRED.test(sentence)) return false;
  if (UNDER_WAY.test(sentence)) return true;
  for (const match of sentence.matchAll(ANNOUNCES)) {
    const after = sentence.slice((match.index ?? 0) + match[0].length);
    const verb = FILLER.exec(after)?.[1]?.toLowerCase();
    if (verb && !NOT_ACTIONS.has(verb)) return true;
  }
  return false;
}

/** The sentences of a paragraph, each trimmed, with line breaks and list items counted as ends. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[^\p{L}\p{N}"'‘“]+/u, "").trim())
    .filter((sentence) => sentence.length > 0)
    .map((sentence) =>
      sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence,
    );
}
