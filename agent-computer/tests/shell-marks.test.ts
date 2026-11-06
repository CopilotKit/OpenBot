import { describe, expect, test } from "bun:test";
import {
  CONTINUED,
  createMarkScanner,
  type MarkEvent,
  readableOutput,
  STARTED,
} from "../src/shell-marks";

/**
 * The marks the live shell prints around each command, read from real terminal output.
 *
 * The reads below are the shapes bash and readline produce through a pseudo-terminal, captured from
 * the shell itself: a command echoed with bracketed paste on, the start mark, its output, the end mark
 * with the nonce, and the next prompt.
 */

const NONCE = "8f14e45fceea167a5a36dedd4bea2543";
const ended = (nonce: string, status: number) =>
  `\x1b]6973;D;${nonce};${status}\x07`;
const PROMPT = "\x1b[?2004h\x1b[38;5;147m~\x1b[0m $ ";

function scanAll(chunks: string[]): MarkEvent[] {
  const scanner = createMarkScanner();
  const events = chunks.flatMap((chunk) => scanner.feed(chunk));
  const rest = scanner.flush();
  return rest ? [...events, { type: "text", text: rest }] : events;
}

/** Adjacent text joined, so the same stream split differently compares equal. */
function normalised(events: MarkEvent[]) {
  const out: MarkEvent[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if (event.type === "text" && last?.type === "text") last.text += event.text;
    else out.push(event.type === "text" ? { ...event } : event);
  }
  return out;
}

const RUN = `ls -la\r\n\x1b[?2004l\r${STARTED}total 0\r\n${ended(NONCE, 0)}${PROMPT}`;

describe("reading the shell's marks", () => {
  test("a command's run reads as its echo, the start, its output, the end and the prompt", () => {
    expect(normalised(scanAll([RUN]))).toEqual([
      { type: "text", text: "ls -la\r\n\x1b[?2004l\r" },
      { type: "mark", mark: { kind: "started" } },
      { type: "text", text: "total 0\r\n" },
      { type: "mark", mark: { kind: "ended", nonce: NONCE, status: 0 } },
      { type: "text", text: PROMPT },
    ]);
  });

  test("a mark split across any two reads is read once and whole", () => {
    const whole = normalised(scanAll([RUN]));
    for (let at = 1; at < RUN.length; at += 1)
      expect(normalised(scanAll([RUN.slice(0, at), RUN.slice(at)]))).toEqual(
        whole,
      );
  });

  test("the unfinished-command mark and an exit status above 9 are read", () => {
    expect(
      normalised(scanAll([`echo "x\r\n${CONTINUED}> ${ended(NONCE, 130)}`])),
    ).toEqual([
      { type: "text", text: 'echo "x\r\n' },
      { type: "mark", mark: { kind: "continued" } },
      { type: "text", text: "> " },
      { type: "mark", mark: { kind: "ended", nonce: NONCE, status: 130 } },
    ]);
  });

  test("text that only looks like a mark is text", () => {
    // Printed by a command as plain characters, not as an escape sequence.
    const lookalike = "]6973;D;deadbeef;0 and \\033]6973;C\\007";
    expect(normalised(scanAll([lookalike]))).toEqual([
      { type: "text", text: lookalike },
    ]);
  });
});

describe("what the Bot reads of a command's output", () => {
  test("colours, marks and cursor movement go, and line endings are newlines", () => {
    expect(
      readableOutput(
        `\x1b[01;34mnotes\x1b[0m  report.md\r\n${ended("abc", 0)}done\r\n`,
      ),
    ).toBe("notes  report.md\ndone\n");
  });

  test("a progress bar keeps its last state", () => {
    expect(readableOutput("10%\r50%\r100%\r\nfinished\r\n")).toBe(
      "100%\nfinished\n",
    );
  });

  test("tabs survive and other control characters do not", () => {
    expect(readableOutput("a\tb\x07\x08c\r\n")).toBe("a\tbc\n");
  });
});
