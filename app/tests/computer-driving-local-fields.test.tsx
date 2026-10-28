import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DemonstrationRecorder } from "@/components/computer/demonstration-recorder";
import { LiveScreen } from "@/components/computer/live-screen";
import { queryClient } from "@/query-client";

/**
 * This page's own fields while a person drives a Bot's browser.
 *
 * LiveScreen used to take every keystroke on the window while someone held the wheel, because its canvas could not
 * hold focus. The full-size view also carries fields of its own, the recorder's workflow name and the secret box, and
 * taking their keys left them dead: typing into "Workflow name" did nothing, and every letter went to the Bot's browser
 * instead. The screen now takes only the keys aimed at it, once a click (or Tab) has given it the focus. And the
 * recorder's button, a Base UI Button, defaults to type="button", so pressing it never submitted the form and no
 * recording ever started.
 */

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

const requests: { method: string; url: string; body: unknown }[] = [];

let originalWebSocket: typeof WebSocket;
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalFetch = globalThis.fetch;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.includes("/control"))
      return Response.json({ holder: "human", transitioning: false });
    if (url.startsWith("/api/demonstrations") && method === "POST")
      return Response.json({ demonstration: { id: "d1" } });
    if (url.startsWith("/api/demonstrations"))
      return Response.json({ demonstrations: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  requests.length = 0;
  SocketDouble.latest = undefined;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function Field() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="Workflow name"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

async function driving(extra?: React.ReactNode) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LiveScreen computerId="fields-test" driving />
      {extra}
    </QueryClientProvider>,
  );
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;
  // Input is sent only once ownership is confirmed; wait for the screen to say so.
  await waitFor(() =>
    expect(document.querySelector("canvas")?.dataset.connected).toBe("true"),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { socket, view, user };
}

test("typing into a field on this page while driving fills it and sends nothing", async () => {
  const { socket, view, user } = await driving(<Field />);
  const field = view.getByLabelText("Workflow name") as HTMLInputElement;

  await user.click(field);
  await user.keyboard("Find an invoice");

  expect(field.value).toBe("Find an invoice");
  expect(socket.sent).toEqual([]);
});

test("a paste into a field on this page stays in the field", async () => {
  const { socket, view } = await driving(<Field />);
  const field = view.getByLabelText("Workflow name");
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "invoice" },
  });

  field.dispatchEvent(paste);

  expect(paste.defaultPrevented).toBe(false);
  expect(socket.sent).toEqual([]);
});

test("keys typed after clicking the screen go to the Bot's browser, with no second click", async () => {
  const { socket, user } = await driving(<Field />);

  await user.click(document.querySelector("canvas") as HTMLCanvasElement);
  await user.keyboard("a");

  // The key, not its legacy code, which the test DOM's keyboard leaves at zero (live-screen-keyboard.test.tsx pins it).
  expect(
    socket.sent.map(({ windowsVirtualKeyCode: _zero, ...sent }) => sent),
  ).toEqual([
    {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0,
    },
    { type: "key", event: "up", key: "a", code: "KeyA", modifiers: 0 },
  ]);
});

test("a key with nothing focused, or a button focused, stays on this page", async () => {
  const { socket } = await driving(<button type="button">Hand back</button>);
  const nowhere = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(nowhere);
  const button = document.querySelector("button") as HTMLButtonElement;
  button.focus();
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(enter);

  expect(nowhere.defaultPrevented).toBe(false);
  expect(enter.defaultPrevented).toBe(false);
  expect(socket.sent).toEqual([]);
});

test("naming a workflow and pressing Record your steps starts a recording", async () => {
  const { socket, view, user } = await driving(
    <DemonstrationRecorder
      botId="fields-test"
      driving
      onRecordingChange={() => {}}
    />,
  );

  await user.click(view.getByLabelText("Workflow name"));
  await user.keyboard("Find an invoice");
  await user.click(view.getByRole("button", { name: "Record your steps" }));

  await waitFor(() =>
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" && request.url === "/api/demonstrations",
      ),
    ).toEqual([
      {
        method: "POST",
        url: "/api/demonstrations",
        body: { botId: "fields-test", title: "Find an invoice" },
      },
    ]),
  );
  expect(socket.sent.filter((message) => message.type === "key")).toEqual([]);
});
