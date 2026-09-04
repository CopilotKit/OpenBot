/**
 * One line a roster can draw: control characters stripped, whitespace collapsed, cut on code points
 * so an emoji is never split. The caller supplies the cap; a preview and a title want different ones.
 */
export function oneLine(text: string, maxCodePoints: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const flattened = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= maxCodePoints) return collapsed;
  return `${codePoints.slice(0, maxCodePoints - 1).join("")}…`;
}
