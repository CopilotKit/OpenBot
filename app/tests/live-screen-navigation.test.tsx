import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveScreen } from "@/components/computer/live-screen";

const nativeWebSocket = globalThis.WebSocket;

class RecordingWebSocket {
  static readonly OPEN = 1;
  static instances: RecordingWebSocket[] = [];

  readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = RecordingWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string | URL) {
    RecordingWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

beforeAll(() => {
  GlobalRegistrator.register();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: RecordingWebSocket,
  });
});

afterEach(() => {
  cleanup();
  RecordingWebSocket.instances = [];
});

afterAll(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: nativeWebSocket,
  });
  GlobalRegistrator.unregister();
});

test("the takeover toolbar sends the three basic browser actions", async () => {
  const view = render(<LiveScreen computerId="bot-1" driving />);

  await userEvent.click(view.getByRole("button", { name: "Go back" }));
  await userEvent.click(view.getByRole("button", { name: "Go forward" }));
  await userEvent.click(view.getByRole("button", { name: "Reload page" }));

  expect(RecordingWebSocket.instances).toHaveLength(1);
  expect(RecordingWebSocket.instances[0]?.sent).toEqual([
    JSON.stringify({ type: "navigation", action: "back" }),
    JSON.stringify({ type: "navigation", action: "forward" }),
    JSON.stringify({ type: "navigation", action: "reload" }),
  ]);
});

test("the navigation toolbar is only shown during takeover", () => {
  const view = render(<LiveScreen computerId="bot-1" driving={false} />);

  expect(
    view.queryByRole("toolbar", { name: "Browser navigation" }),
  ).toBeNull();
});

test("the takeover toolbar can be reached and operated with the keyboard", async () => {
  const view = render(<LiveScreen computerId="bot-1" driving />);
  const user = userEvent.setup({ document: globalThis.document });

  await user.tab();
  expect(globalThis.document.activeElement).toBe(
    view.getByRole("button", { name: "Go back" }),
  );
  await user.keyboard("{Enter}");

  await user.tab();
  expect(globalThis.document.activeElement).toBe(
    view.getByRole("button", { name: "Go forward" }),
  );
  await user.keyboard(" ");

  expect(RecordingWebSocket.instances[0]?.sent).toEqual([
    JSON.stringify({ type: "navigation", action: "back" }),
    JSON.stringify({ type: "navigation", action: "forward" }),
  ]);
});

test("Tab is forwarded to the remote page while the live screen has focus", async () => {
  const view = render(<LiveScreen computerId="bot-1" driving />);
  const user = userEvent.setup({ document: globalThis.document });
  const screen = view.getByLabelText(
    "The assistant's screen. You have control: click and type here.",
  );

  screen.focus();
  expect(globalThis.document.activeElement).toBe(screen);
  await user.tab();

  expect(RecordingWebSocket.instances[0]?.sent).toEqual([
    JSON.stringify({
      type: "key",
      event: "down",
      key: "Tab",
      code: "Tab",
      modifiers: 0,
    }),
    JSON.stringify({
      type: "key",
      event: "up",
      key: "Tab",
      code: "Tab",
      modifiers: 0,
    }),
  ]);
});
