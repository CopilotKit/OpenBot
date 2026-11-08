/*
 * How a learned skill reads to a person. Intelligence names a skill with the slug its SKILL.md gives itself
 * ("example-domain-learnmore-navigation") and has no display name beside it, and the Learning agent writes the steps for
 * the Bot, recorder selector notes and all. Everything here changes only what a person reads: the skill a Bot loads is
 * the stored text, untouched.
 */

/** The words of a piece of text, each with the form it was written in. */
function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * A word as it goes into a title: kept as written when its casing means something (an acronym, "GitHub"), else in lower
 * case, since a capital at the start of a word is as likely to be the start of a sentence.
 */
function titleWord(word: string): string {
  const rest = word.slice(1);
  return rest !== rest.toLowerCase() ? word : word.toLowerCase();
}

/**
 * One slug part in readable words, using how the skill's own text writes it: "learnmore" is "learn more" where the
 * description says "Learn more", and "pdf" is "PDF" where it says "PDF". A part the text never writes stays as it is.
 */
function partInWords(part: string, context: string[]): string {
  const wanted = part.toLowerCase();
  for (let start = 0; start < context.length; start++) {
    let joined = "";
    for (let end = start; end < context.length && end < start + 4; end++) {
      joined += (context[end] ?? "").toLowerCase();
      if (joined === wanted)
        return context
          .slice(start, end + 1)
          .map(titleWord)
          .join(" ");
      if (!wanted.startsWith(joined)) break;
    }
  }
  return wanted;
}

/**
 * A learned skill's name as a title a person reads: "example-domain-learnmore-navigation" is "Example domain learn more
 * navigation". `context` is the skill's own description, whose words split and case the slug's parts. A name that is
 * already words ("Refund triage") is kept as it is.
 */
export function skillTitle(name: string, context = ""): string {
  if (/\s/.test(name.trim()) || !/[-_]/.test(name)) {
    const kept = name.trim();
    // A one-word slug still reads as a word: "invoices" is "Invoices".
    return /\s/.test(kept)
      ? kept
      : kept.charAt(0).toUpperCase() + kept.slice(1);
  }
  const words = wordsOf(context);
  const title = name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => partInWords(part, words))
    .join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** SKILL.md without its front matter, whose name and description the screen's header already shows. */
export function skillBody(markdown: string): string {
  return markdown
    .replace(/^﻿/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .trim();
}

/** The keys of the element details the Recorder captures, as the Learning agent copies them into a step. */
const SELECTOR_KEY = String.raw`(?:tag|tag-?name|role|aria-?role|aria-?label|label|id|name|type|input-?type|href|class|class-?name|selector|css|xpath|placeholder|title|alt|for|value|text|test-?id|data-[\w-]+|nth|index)`;
/** One `key=value` detail, the value bare or quoted, the pair optionally in backticks. */
const SELECTOR_PAIR = String.raw`\x60?${SELECTOR_KEY}\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;)\]\x60]+)\x60?`;
const SELECTOR_LIST = String.raw`${SELECTOR_PAIR}(?:\s*[,;]?\s*${SELECTOR_PAIR})*`;
/** A note made only of selector details: "(tag=a)", "[tag=button, id=save]", "`tag=a`". */
const SELECTOR_NOTE = new RegExp(
  String.raw`[ \t]*(?:\(\s*${SELECTOR_LIST}\s*\)|\[\s*${SELECTOR_LIST}\s*\](?!\()|\x60${SELECTOR_KEY}\s*=[^\x60\n]*\x60)`,
  "gi",
);

/**
 * A skill's steps as a person reads them: the front matter gone, and the Recorder's selector notes that the steps carry
 * for the Bot ("click the 'Learn more' link (tag=a)") taken out, since the step already says what to click.
 */
export function readableSkillBody(markdown: string): string {
  return skillBody(markdown).replace(SELECTOR_NOTE, "");
}
