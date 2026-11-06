import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { LiveShell, ViewerHandle } from "./live-shell";

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
 * Its own file so the rules can be tested without importing `index.ts`, which starts a server, and so
 * the live screen's handlers there stay the live screen's.
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

/** What a terminal socket carries, beside whatever the computer's other sockets carry. */
export type TerminalSocketData = {
  /** A terminal rather than the live screen. */
  kind?: "terminal";
  /** Why this computer shows no terminal, said once the socket opens. */
  refused?: string;
  /** The shell a terminal socket watches, and its place among the viewers. */
  shell?: LiveShell;
  viewer?: ViewerHandle;
  closed?: boolean;
};

/**
 * The computer's terminal sockets, and how they share the one WebSocket handler Bun allows.
 *
 * `around` takes the live screen's handlers and answers a terminal socket itself, leaving every other
 * socket to them untouched, so the two never reach into each other's code.
 *
 * Watching needs nothing more than the socket. Typing needs the wheel, asked of the control state on
 * every message, the same question the live screen asks.
 */
export function createTerminalSockets<
  T extends TerminalSocketData & { botId: string },
>(deps: {
  /** The seat's live shell, started if it has none. */
  shellFor: (seat: string) => Promise<LiveShell>;
  /** Whether a person holds this seat's wheel, with nothing of the Bot's still running. */
  mayType: (seat: string) => boolean;
  /** What a keystroke without the wheel is told. */
  takeControlFirst: string;
  describe: (error: unknown, fallback: string) => string;
}) {
  async function open(ws: ServerWebSocket<T>): Promise<void> {
    if (ws.data.refused) {
      ws.send(
        JSON.stringify({ type: "error", error: ws.data.refused, fatal: true }),
      );
      ws.close();
      return;
    }
    try {
      const shell = await deps.shellFor(ws.data.botId);
      if (ws.data.closed) return;
      ws.data.shell = shell;
      ws.data.viewer = shell.attach({
        binary: (bytes) => {
          // Bun answers 0 for a message it dropped because the socket has gone.
          if (ws.send(bytes) === 0 && bytes.byteLength > 0)
            throw new Error("The socket is closed.");
        },
        text: (message) => {
          ws.send(JSON.stringify(message));
        },
      });
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: deps.describe(error, "The terminal could not be started."),
        }),
      );
      ws.close();
    }
  }

  function message(ws: ServerWebSocket<T>, raw: string | Buffer): void {
    const parsed = parseTerminalMessage(raw);
    if (!parsed.ok) {
      ws.send(JSON.stringify({ type: "error", error: parsed.error }));
      return;
    }
    const { message } = parsed;
    const shell = ws.data.shell;
    if (!shell) return;
    if (message.type === "ack") {
      ws.data.viewer?.ack(message.bytes);
      return;
    }
    if (message.type === "resize") {
      shell.resize(message.cols, message.rows);
      return;
    }
    // The person's own keystrokes, only while they hold the wheel. Never a Bot's action, so never audited as one.
    if (!deps.mayType(ws.data.botId)) {
      ws.send(JSON.stringify({ type: "error", error: deps.takeControlFirst }));
      return;
    }
    shell.input(message.data);
  }

  function close(ws: ServerWebSocket<T>): void {
    ws.data.closed = true;
    ws.data.viewer?.detach();
  }

  return {
    around(screen: WebSocketHandler<T>): WebSocketHandler<T> {
      return {
        ...screen,
        open(ws) {
          if (ws.data.kind === "terminal") return open(ws);
          return screen.open?.(ws);
        },
        message(ws, raw) {
          if (ws.data.kind === "terminal") return message(ws, raw);
          return screen.message(ws, raw);
        },
        close(ws, code, reason) {
          if (ws.data.kind === "terminal") return close(ws);
          return screen.close?.(ws, code, reason);
        },
        drain(ws) {
          if (ws.data.kind === "terminal") return;
          return screen.drain?.(ws);
        },
      };
    },
  };
}
