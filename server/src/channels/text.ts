import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * The unit a person sees as one character.
 *
 * `Array.from` splits on code points, which is right for a plain emoji and wrong for every emoji
 * built out of more than one. A flag is two regional indicators, a family is three people joined by
 * zero-width joiners, a thumbs-up with a skin tone is the thumb plus a modifier, and a keycap is a
 * digit plus a variation selector plus an enclosing mark. Cut between any of those parts and what is
 * left is not a shorter emoji: it is a boxed letter, a dangling joiner, or a bare digit.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The first `limit` UTF-16 code units of `text`, one fewer when the cut would split a character.
 *
 * `slice` counts code units, and every emoji, every astral-plane glyph and every CJK extension
 * character is two of them. A limit landing between the two halves leaves a lone high surrogate as
 * the last unit, which is not a character: `JSON.stringify` sends it as a bare `\ud83d` and UTF-8
 * encodes it as U+FFFD, so whatever reads the cut text — a model, most often — is handed a broken
 * character that was never in the source. `extractDocumentText` guards the same cut on attachments.
 *
 * The orphan is dropped rather than completed, so the result never exceeds the limit it was asked
 * for. It cannot be a lone surrogate that was already in the text and happened to land last: only a
 * high surrogate is dropped, and one followed by its pair in the source is exactly the split case.
 */
export function cutAtCodeUnits(text: string, limit: number): string {
  const sliced = text.slice(0, limit);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * One line a roster can draw: control characters stripped, whitespace collapsed, cut on grapheme
 * clusters so an emoji is never split. The caller supplies the cap; a preview and a title want
 * different ones.
 */
export function oneLine(text: string, maxGraphemes: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const flattened = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  // A string can never hold more graphemes than it holds UTF-16 units, so a line this short is
  // already under the cap and needs no segmenting. Nearly everything a roster draws is that short,
  // and segmenting is the expensive part of this function.
  if (collapsed.length <= maxGraphemes) return collapsed;
  const graphemes = Array.from(
    GRAPHEMES.segment(collapsed),
    (each) => each.segment,
  );
  if (graphemes.length <= maxGraphemes) return collapsed;
  return `${graphemes.slice(0, maxGraphemes - 1).join("")}…`;
}

/**
 * How long a conversation's name may run. A title long enough to truncate says no more than the
 * preview it replaced.
 */
export const MAX_TITLE_GRAPHEMES = 60;

/** The parts of a parsed message this reads: a node's text, an image's words, and what it holds. */
type MarkdownNode = {
  type: string;
  value?: unknown;
  alt?: unknown;
  children?: MarkdownNode[];
};

/** Nodes whose children are separate blocks, a paragraph or an item each, so a space goes between. */
const BLOCK_PARENTS = new Set(["root", "blockquote", "list", "listItem"]);

/**
 * How much of a message is parsed. A roster line is the first few dozen characters, and a reply can
 * be many thousands, so the rest is never read. Generous, so a construct opened near the start is
 * still closed inside it: what is cut off past here is never drawn either way.
 */
const MAX_PARSED_CODE_UNITS = 4_000;

function textOf(node: MarkdownNode): string {
  if (node.type === "image" || node.type === "imageReference")
    return typeof node.alt === "string" ? node.alt : "";
  if (node.type === "break") return "\n";
  // Text, inline code, a code block and raw HTML are all words somebody wrote, so they stay.
  if (typeof node.value === "string") return node.value;
  const children = node.children ?? [];
  return children.map(textOf).join(BLOCK_PARENTS.has(node.type) ? "\n" : "");
}

/**
 * What a message says with its Markdown taken off: `**kubectl**` is `kubectl`, `[docs](https://…)`
 * is `docs`, `# Status` is `Status`, a list is its items.
 *
 * A Bot answers in Markdown, and the transcript draws it, but a roster line is plain text. Drawn as
 * it was written, a reply's asterisks and pound signs became part of the conversation's name in the
 * sidebar. Parsed rather than pattern-matched, so a `*` or `_` that is not formatting (`2 * 3`,
 * `snake_case`) is left exactly where it was, the way the transcript leaves it.
 */
export function plainText(markdown: string): string {
  const root: MarkdownNode = fromMarkdown(
    cutAtCodeUnits(markdown, MAX_PARSED_CODE_UNITS),
  );
  return textOf(root);
}

/** {@link plainText} on one line, the way a roster draws it. See {@link oneLine}. */
export function plainLine(markdown: string, maxGraphemes: number): string {
  return oneLine(plainText(markdown), maxGraphemes);
}
