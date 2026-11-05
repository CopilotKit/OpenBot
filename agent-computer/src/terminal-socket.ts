/**
 * What a terminal viewer may send the computer, read and bounded before anything acts on it.
 *
 * THE PROTOCOL. One socket per viewer, at `/terminal` on the computer and proxied by the server from
 * `/api/computers/:botId/terminal`, behind the same checks as the live screen.
 *
 * From the computer: binary frames are the terminal's own bytes. Text frames are JSON: `snapshot`
 * (reset, and the bytes that follow redraw the screen as it is), `ready` (live from here on), and
 * `error` (with `fatal` when retrying will not help).
 *
 * From the viewer, all JSON text: `input` (what the person typed, accepted only while they hold the
 * wheel), `resize` (the size the viewer's terminal fits, which the shell takes), and `ack` (bytes the
 * viewer has drawn, which is the flow control in live-shell.ts).
 *
 * Its own file so the rules can be tested without importing `index.ts`, which starts a server.
 */

export type TerminalMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ack"; bytes: number };

/** More than any paste a person makes in one go, and far less than would hurt the computer. */
export const MAX_TERMINAL_INPUT = 64 * 1024;

/** Said where commands are turned off on this computer, so there is no shell to show. */
export const TERMINAL_UNAVAILABLE =
  "This computer doesn't run commands, so there's no terminal to show.";

export function parseTerminalMessage(
  raw: string | Buffer | ArrayBuffer | Uint8Array,
): { ok: true; message: TerminalMessage } | { ok: false; error: string } {
  if (typeof raw !== "string")
    return { ok: false, error: "Send terminal messages as JSON text." };
  if (raw.length > MAX_TERMINAL_INPUT * 2)
    return { ok: false, error: "That message is too long." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "That message is not JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, error: "That message is not a terminal message." };
  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case "input":
      if (
        typeof message.data !== "string" ||
        message.data.length === 0 ||
        message.data.length > MAX_TERMINAL_INPUT
      )
        return { ok: false, error: "Input is text of at most 64 KB." };
      return { ok: true, message: { type: "input", data: message.data } };
    case "resize":
      if (
        !Number.isInteger(message.cols) ||
        !Number.isInteger(message.rows) ||
        (message.cols as number) <= 0 ||
        (message.rows as number) <= 0
      )
        return { ok: false, error: "A size is whole columns and rows." };
      return {
        ok: true,
        message: {
          type: "resize",
          cols: message.cols as number,
          rows: message.rows as number,
        },
      };
    case "ack":
      if (
        typeof message.bytes !== "number" ||
        !Number.isFinite(message.bytes) ||
        message.bytes <= 0
      )
        return { ok: false, error: "An ack counts bytes." };
      return { ok: true, message: { type: "ack", bytes: message.bytes } };
    default:
      return { ok: false, error: "That message is not a terminal message." };
  }
}
