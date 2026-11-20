/**
 * `slice` counts UTF-16 code units, and an emoji or any other astral-plane character is two of them.
 * A cut between the two halves leaves half a character, which a caption draws as a box and which
 * reaches the voice model as a character that was never said. These cuts drop the half instead, so
 * the result is one unit shorter at most and never longer than the limit.
 */

/** The first `limit` code units of `text`, without a trailing half character. */
export function openingOf(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const opening = text.slice(0, limit);
  const last = opening.charCodeAt(opening.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? opening.slice(0, -1) : opening;
}

/** The last `limit` code units of `text`, without a leading half character. */
export function closingOf(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const closing = text.slice(text.length - limit);
  const first = closing.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? closing.slice(1) : closing;
}
