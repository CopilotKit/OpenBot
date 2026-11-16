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

/**
 * The line Learning gives a skill it reduced from its final insights: "Supported by final Insights: <alias>, <alias>.".
 * The aliases name insights the proposal's Learned from already shows in full. The Learning agent picks each alias
 * itself, in any case and with any separator ("refund-triage", "vendor_payments_house_format", "refundV2"), so an
 * alias is everything up to the next space or comma, its closing full stop included.
 */
const INSIGHT_SLUGS =
  /Supported by (?:final )?Insights?:\s*[^\s,]+(?:\s*,\s*[^\s,]+)*\.?/gi;

/**
 * Why Learning proposes a skill, as a person reads it: the words Learning wrote, without a line that only names
 * insights by slug. Null when nothing is left to say.
 */
export function proposalReason(reason: string): string | null {
  const words = reason.replace(INSIGHT_SLUGS, "").replace(/\s+/g, " ").trim();
  return words === "" ? null : words;
}

/*
 * A Learning container, as an admin reads and names it.
 *
 * Where OpenBot keeps a container for an organization alone, the server names it with an id that says nothing to a
 * person (`organizationSpaceId`, api/openapi/learning.yaml), and every other container of the organization's is that
 * id, a hyphen, then a name its admin chose. That id is never drawn: the organization's own container is named for
 * the organization, and another by the admin's name alone. Where the server names no such container (`own` is null),
 * an id is what an admin typed and reads as it is.
 */

/** An id the server derived for an organization's or a person's container. It says nothing to a person. */
const DERIVED_CONTAINER = /^(?:org|user)-[0-9a-f]{32}(?:-|$)/;

/** The name an admin gave a container, which is what its field holds. Empty for the organization's own. */
export function containerName(own: string | null, containerId: string): string {
  if (own === null) return containerId;
  if (containerId === own) return "";
  if (containerId.startsWith(`${own}-`))
    return containerId.slice(own.length + 1);
  // Not this organization's, which the server never sends it. A derived id is still never drawn.
  return DERIVED_CONTAINER.test(containerId) ? "" : containerId;
}

/** The id the server keeps for the name an admin typed. No name is the organization's own container. */
export function containerIdFor(own: string | null, name: string): string {
  if (own === null) return name;
  return name === "" ? own : `${own}-${name}`;
}

/** The longest name an admin can give a container, so that its id stays within the server's 64 characters. */
export function containerNameLimit(own: string | null): number {
  return own === null ? 64 : 64 - own.length - 1;
}

/** Which container a page is showing, in words. `organization` is the name of the one the person works in. */
export function containerTitle(
  container: { id: string; name: string },
  own: string | null,
  organization: string | undefined,
): string {
  if (own === null) return `${container.name} (${container.id})`;
  const name = containerName(own, container.id);
  if (name === "")
    return organization
      ? `Default container for ${organization}`
      : "This organization's default container";
  return organization
    ? `The "${name}" container for ${organization}`
    : `The "${name}" container`;
}
