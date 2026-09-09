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
