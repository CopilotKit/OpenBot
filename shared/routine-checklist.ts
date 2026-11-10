/**
 * The checklist a multi-part routine's run has to close.
 *
 * A routine written as a list ("1. pull the cycle from Linear, 2. match it against the Notion page,
 * 3. rank what is left") is several pieces of work, and a run that does the first two and stops has
 * not finished. The parts are read from the instruction's own list, and every one has to end Done,
 * Blocked (with the reason) or Skipped (with the reason) before the run may end. The run harness
 * holds the run to it (`toolkit/src/copilotkit/last-step.ts`); this file only reads.
 */

import type { OpenPart } from "./run-notices";

/**
 * A list longer than this is data rather than parts: twenty issue ids to look at are one job, not
 * twenty, and a checklist of twenty would ask for twenty status lines.
 */
export const MOST_PARTS = 10;

/** How much of a part a nudge quotes back, in code points. */
const PART_SHOWN = 80;

const LIST_ITEM = /^(\s*)(?:[-*•+]|\d{1,2}[.)]|[a-z][.)])\s+(\S.*)$/i;

/**
 * The parts of an instruction written as a list, or none.
 *
 * Only the outermost list counts: an indented line under a part is that part's detail, not a part
 * of its own. Fewer than two items is not a multi-part routine, and more than {@link MOST_PARTS}
 * is a list of things to work through rather than a list of parts.
 */
export function routineParts(instruction: string): string[] {
  const items: { indent: number; text: string }[] = [];
  for (const line of instruction.split(/\r?\n/)) {
    const match = LIST_ITEM.exec(line);
    if (!match) continue;
    items.push({
      indent: (match[1] ?? "").replace(/\t/g, "    ").length,
      text: (match[2] ?? "").replace(/\s+/g, " ").trim(),
    });
  }
  if (items.length === 0) return [];
  const outer = Math.min(...items.map((item) => item.indent));
  const parts = items
    .filter((item) => item.indent === outer && item.text.length > 0)
    .map((item) => shorten(item.text));
  return parts.length >= 2 && parts.length <= MOST_PARTS ? parts : [];
}

const STATUS = /\b(?:done|blocked|skipped)\b/i;

/** "1.", "2)", "Part 3:", "#4 -", "5 |", as a line that closes a part starts. */
const NUMBERED =
  /^(?:part|item|step)?\s*#?(\d{1,2})\s*(?:[.):|\]–—-]|\s(?=done|blocked|skipped))/i;

/**
 * The parts nothing in `said` has closed yet.
 *
 * A part is closed by a line that names it and says Done, Blocked or Skipped. Named by its number,
 * the way the run is asked to, or by the start of its own words, the way a model sometimes writes
 * it anyway. Whatever leads the line first is ignored: a bullet, a table's pipe, bold, an emoji.
 */
export function openParts(parts: readonly string[], said: string): OpenPart[] {
  const closed = new Set<number>();
  for (const raw of said.split(/\r?\n/)) {
    if (!STATUS.test(raw)) continue;
    const line = raw.replace(/^[^\p{L}\p{N}]+/u, "");
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      closed.add(Number(numbered[1]));
      continue;
    }
    const words = normal(line);
    parts.forEach((part, index) => {
      const start = normal(part).slice(0, 30);
      if (start.length >= 8 && words.includes(start)) closed.add(index + 1);
    });
  }
  return parts
    .map((text, index) => ({ number: index + 1, text }))
    .filter((part) => !closed.has(part.number));
}

function normal(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function shorten(text: string): string {
  const points = Array.from(text);
  return points.length <= PART_SHOWN
    ? text
    : `${points.slice(0, PART_SHOWN - 1).join("")}…`;
}
