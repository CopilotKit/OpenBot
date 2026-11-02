/**
 * A Bot's reply as the separate thoughts a chat draws as separate bubbles: one bubble per paragraph,
 * 8px apart, as a person texting would send them, instead of one tall bubble holding everything.
 *
 * Paragraphs are split on blank lines, with these exceptions that keep markdown whole:
 * - nothing is split inside a fenced code block, including one still streaming in;
 * - a list stays with the line that introduces it ("Three things I could start on:"), and its items
 *   stay together even when the model put blank lines between them;
 * - a table stays in one piece;
 * - a heading stays with what follows it, and so does a line that introduces what comes next
 *   ("Source:"), so neither is a bubble of its own;
 * - a block with nothing to read in it (a `---` between sections, a stray `&nbsp;`) is no bubble.
 */
export function splitBubbles(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fenced = false;
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  const bubbles: string[] = [];
  for (const block of blocks) {
    if (!readable(block)) continue;
    const previous = bubbles.at(-1);
    if (previous !== undefined && belongsWith(previous, block)) {
      bubbles[bubbles.length - 1] = `${previous}\n\n${block}`;
    } else {
      bubbles.push(block);
    }
  }
  return bubbles.length > 0 ? bubbles : [text];
}

/**
 * Whether a bubble holds a fenced code block or a table, which wants the whole column on a wide
 * screen: a line of code or a row of cells cut at a prose width scrolls sideways inside its bubble.
 */
export function holdsBlock(bubble: string): boolean {
  return bubble
    .split("\n")
    .some((line) => FENCE.test(line) || TABLE_ROW.test(line));
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s/;
const TABLE_ROW = /^\s*\|/;

/**
 * Whether a block has anything to read once drawn. A thematic break, a non-breaking space or a lone
 * emphasis marker draws as an empty bubble. Anything inside a code fence is read as it is.
 */
function readable(block: string): boolean {
  if (FENCE.test(block)) return true;
  return (
    block.replace(/<br\s*\/?>|&nbsp;/gi, "").replace(/[\s#*_\-=>|~`]/g, "") !==
    ""
  );
}

/** Whether a block continues the bubble before it rather than starting one of its own. */
function belongsWith(previous: string, block: string): boolean {
  const lastLine = previous.split("\n").at(-1) ?? "";
  // A heading, or a line that introduces what follows ("Source:", "**Next steps:**"), leads into it.
  if (HEADING.test(lastLine) || /:\s*$/.test(lastLine.replace(/[*_]+\s*$/, "")))
    return true;
  if (LIST_ITEM.test(block))
    return LIST_ITEM.test(lastLine) || lastLine.trimEnd().endsWith(":");
  if (TABLE_ROW.test(block)) return TABLE_ROW.test(lastLine);
  // An indented block under a list item is that item's continuation.
  if (/^\s{2,}\S/.test(block))
    return previous.split("\n").some((line) => LIST_ITEM.test(line));
  return false;
}
