import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { LiveScreen } from "@/components/computer/live-screen";

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
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

async function liveSocket(): Promise<SocketDouble> {
  render(<LiveScreen computerId="keyboard-test" driving />);
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  return SocketDouble.latest as SocketDouble;
}

for (const [name, modifier] of [
  ["Ctrl+V", { ctrlKey: true }],
  ["Cmd+V", { metaKey: true }],
] as const) {
  test(`${name} stays in the local page so it can produce a paste event`, async () => {
    const socket = await liveSocket();
    const shortcut = new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      ...modifier,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(shortcut);

    expect(shortcut.defaultPrevented).toBe(false);
    expect(socket.sent).toEqual([]);
  });
}

test("a period carries the browser's virtual key code to the remote screen", async () => {
  const socket = await liveSocket();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: ".",
      code: "Period",
      keyCode: 190,
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: ".",
      code: "Period",
      text: ".",
      windowsVirtualKeyCode: 190,
      modifiers: 0,
    },
  ]);
});

test("Ctrl+A remains a remote keyboard shortcut", async () => {
  const socket = await liveSocket();
  const shortcut = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });

  window.dispatchEvent(shortcut);

  expect(shortcut.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    },
  ]);
});

test("the paste event sends clipboard text without forwarding it through a key event", async () => {
  const socket = await liveSocket();
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "." },
  });

  window.dispatchEvent(paste);

  expect(paste.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([{ type: "text", text: "." }]);
});
