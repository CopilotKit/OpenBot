import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { LiveTerminal } from "@/components/computer/live-terminal";

/**
 * The Terminal tab's terminal, attached to its socket as the browser attaches it.
 *
 * The socket stands in for the server's proxy and speaks its protocol: a snapshot, the screen's bytes as binary, then
 * `ready`, then live bytes. What is pinned is that the terminal connects to the Bot's terminal path, draws the bytes it
 * is sent, acknowledges them, and sends the person's typing only while they hold the wheel.
 */

class SocketDouble {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(readonly url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }

  receive(data: string | Uint8Array) {
    this.onmessage?.({
      data:
        typeof data === "string"
          ? data
          : data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ),
    });
  }
}

let originalWebSocket: typeof WebSocket;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
});

afterEach(() => {
  cleanup();
  SocketDouble.latest = undefined;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

const bytes = (text: string) => new TextEncoder().encode(text);

/** The text xterm.js has drawn, row by row. */
function drawn(container: HTMLElement): string {
  return [...container.querySelectorAll(".xterm-rows > div")]
    .map((row) => row.textContent ?? "")
    .join("\n");
}

async function attached(driving: boolean) {
  const view = render(
    <LiveTerminal computerId="notes-bot" driving={driving} />,
  );
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;
  act(() => {
    socket.receive(JSON.stringify({ type: "snapshot", cols: 80, rows: 24 }));
    socket.receive(
      bytes("~ $ echo hello from the bot\r\nhello from the bot\r\n~ $ "),
    );
    socket.receive(JSON.stringify({ type: "ready" }));
  });
  return { view, socket };
}

test("it connects to the Bot's terminal and draws what the shell prints", async () => {
  const { view, socket } = await attached(false);
  expect(socket.url).toEndWith("/api/computers/notes-bot/terminal");
  expect(socket.binaryType).toBe("arraybuffer");
  await waitFor(() =>
    expect(drawn(view.container)).toContain("hello from the bot"),
  );
  // What it drew is acknowledged, which is what keeps the computer sending.
  await waitFor(() =>
    expect(socket.sent.some((message) => message.type === "ack")).toBe(true),
  );
});

test("typing reaches the shell only while the person holds the wheel", async () => {
  const watching = await attached(false);
  const textarea = () =>
    watching.view.container.querySelector("textarea") as HTMLTextAreaElement;
  await waitFor(() => expect(textarea()).toBeTruthy());
  textarea().dispatchEvent(
    new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true }),
  );
  expect(watching.socket.sent.filter((m) => m.type === "input")).toEqual([]);

  watching.view.rerender(<LiveTerminal computerId="notes-bot" driving />);
  await waitFor(() => expect(document.activeElement).toBe(textarea()));
  textarea().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
    }),
  );
  await waitFor(() =>
    expect(watching.socket.sent.filter((m) => m.type === "input")).toEqual([
      { type: "input", data: "\r" },
    ]),
  );
});
