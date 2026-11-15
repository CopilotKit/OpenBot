/*
 * The one line a task says under its title, wherever it is listed: the Needs you board, a Bot's
 * Activity page and the task list. The server hands over the Bot's own closing words, which are
 * Markdown and can be the last row of a table or a note of where the answer came from. A row is one
 * line of plain text, so the marks come off here, and a line that says nothing about the task is
 * left out: the title and the status stand on their own.
 */

/** A line that only says where an answer came from: "Source: …", "References - …". */
const FOOTNOTE = /^(?:sources?|references?|citations?)\s*[:：\-–]/i;

/** A table's rule under its heading: `| --- | :--: |`. */
const TABLE_RULE = /^:?-{2,}:?$/;

/** One row of a Markdown table as a sentence would say it: "Begins: Columbia Lake". */
function tableRow(line: string): string | null {
  const row = line.trim();
  if (!row.startsWith("|") && !row.endsWith("|")) return null;
  const cells = row
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length === 0 || cells.every((cell) => TABLE_RULE.test(cell)))
    return "";
  const [first, ...rest] = cells;
  return rest.length ? `${first}: ${rest.join(", ")}` : (first ?? "");
}

/** Markdown's marks taken off one line, leaving the words. */
function withoutMarks(line: string): string {
  return (
    line
      // An image says nothing in a line of text; a link keeps the words it was on.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/<\/?[a-z][^>]*>/gi, "")
      // A heading, a quote, a list item or a task box at the start of the line.
      .replace(/^\s*(?:#{1,6}|>+|[-*+•]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "")
      // What was struck through was taken back, so it is not said.
      .replace(/~~[^~]*~~\s*/g, "")
      // Emphasis and code. An underscore inside a word is part of the word.
      .replace(/`+/g, "")
      .replace(/\*+|~~/g, "")
      .replace(/(^|[^\p{L}\p{N}])_+(?=\S)/gu, "$1")
      .replace(/(?<=\S)_+(?=$|[^\p{L}\p{N}])/gu, "")
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * A task's line as plain text, or null when it has nothing to say about the task.
 *
 * Left out, not shown: a line with no words in it (a table's rule, a row of marks), and a note of
 * where the answer came from, which is a footnote to a result the row does not hold.
 */
export function taskLine(said: string | null | undefined): string | null {
  const lines = (said ?? "")
    .split("\n")
    .map((line) => withoutMarks(tableRow(line) ?? line))
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  const text = lines.join(" ").trim();
  if (!text || FOOTNOTE.test(text)) return null;
  return text;
}
