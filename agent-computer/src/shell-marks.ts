/**
 * Where a command starts and ends in the output of the Bot's live shell.
 *
 * WHY MARKS. One bash runs for the whole life of a Bot's computer (live-shell.ts), so a person can
 * watch it and take the keyboard. A command's output is no longer a process's stdout that ends when
 * the process does: it is a stretch of one long terminal stream, and the Bot still needs that stretch
 * and the command's exit code. The shell says where the stretch is, with private escape sequences the
 * computer writes into its prompts (`PS0` before a command runs, `PROMPT_COMMAND` after it ends, `PS2`
 * when the shell is waiting for the rest of an unfinished command). VS Code's shell integration does
 * the same with OSC 633; this uses its own number so neither is mistaken for the other.
 *
 * WHY THEY CANNOT BE FORGED BY OUTPUT. The end mark carries a nonce the computer mints for each command
 * and writes to a file outside the workspace just before typing it. Nothing prints it until the
 * command has finished, so no text the command prints (a file it reads, a page it fetches, an `echo`
 * the Bot wrote) can contain it. A mark with any other nonce is output like any other text. A terminal
 * ignores an OSC it does not know, so a person watching never sees any of this.
 */

/** The OSC number the computer's shell uses for its own marks. Not one any terminal assigns. */
export const MARK_OSC = "6973";

/** Printed by `PS0`: a command line was read and is about to run. */
export const STARTED = `\x1b]${MARK_OSC};C\x07`;
/** Printed by `PS2`: the shell is waiting for the rest of an unfinished command. */
export const CONTINUED = `\x1b]${MARK_OSC};P\x07`;
/** The start of the mark `PROMPT_COMMAND` prints: `D;<nonce>;<exit status>`. */
const ENDED_PREFIX = `\x1b]${MARK_OSC};D;`;

export type ShellMark =
  | { kind: "started" }
  | { kind: "continued" }
  | { kind: "ended"; nonce: string; status: number };

export type MarkEvent =
  | { type: "text"; text: string }
  | { type: "mark"; mark: ShellMark };

const MARK = new RegExp(
  `\\x1b\\]${MARK_OSC};(?:(C)|(P)|D;([0-9a-f]{0,64});(\\d{1,3}))\\x07`,
  "g",
);

/** Longer than any complete mark, so a mark split across two reads is always held whole. */
const LONGEST_MARK = ENDED_PREFIX.length + 64 + 1 + 3 + 1;

/**
 * Turn the shell's output, as it arrives, into text and marks.
 *
 * Reads arrive in whatever pieces the PTY hands over, and a mark can be split across two of them.
 * The tail of each piece that could still be the start of a mark is held back until the next one,
 * so nothing is reported twice and no mark is missed.
 */
export function createMarkScanner() {
  let held = "";
  return {
    feed(text: string): MarkEvent[] {
      const scan = held + text;
      const events: MarkEvent[] = [];
      let at = 0;
      MARK.lastIndex = 0;
      for (
        let match = MARK.exec(scan);
        match !== null;
        match = MARK.exec(scan)
      ) {
        if (match.index > at)
          events.push({ type: "text", text: scan.slice(at, match.index) });
        events.push({
          type: "mark",
          mark: match[1]
            ? { kind: "started" }
            : match[2]
              ? { kind: "continued" }
              : {
                  kind: "ended",
                  nonce: match[3] ?? "",
                  status: Number(match[4]),
                },
        });
        at = match.index + match[0].length;
      }
      // Hold back only what could still become a mark: from the last escape near the end.
      const tailStart = Math.max(at, scan.length - LONGEST_MARK);
      const lastEscape = scan.indexOf("\x1b", tailStart);
      const keepFrom = lastEscape === -1 ? scan.length : lastEscape;
      if (keepFrom > at)
        events.push({ type: "text", text: scan.slice(at, keepFrom) });
      held = scan.slice(keepFrom);
      return events;
    },
    /** Whatever was held back, for a stream that has ended. */
    flush(): string {
      const rest = held;
      held = "";
      return rest;
    },
  };
}

/**
 * A terminal's output as the text a model reads.
 *
 * Colours, cursor movement and the shell's marks go, a carriage return overwrites the line the way
 * it does on screen (a progress bar keeps its last state), and line endings are plain newlines.
 */
export function readableOutput(raw: string): string {
  const stripped = Bun.stripANSI(raw).replace(/\r\n/g, "\n");
  const lines = stripped.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    const parts = line.split("\r").filter((part) => part !== "");
    return parts.at(-1) ?? "";
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing the control characters is the point.
  return lines.join("\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
