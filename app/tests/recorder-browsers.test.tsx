import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { BrowserSections } from "@/components/settings/browsers/browser-sections";
import { ConnectedBrowsers } from "@/components/settings/browsers/connected-browsers";
import { ThisBrowser } from "@/components/settings/browsers/this-browser";
import { queryClient } from "@/query-client";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  // The query library decided "server" when it was imported, before the DOM existed, and so never polls.
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const EXTENSION_ID = "a".repeat(32);
const THIS_COPY = "c".repeat(32);
const OTHER_COPY = "d".repeat(32);
const originalFetch = global.fetch;
let connectionsFail = false;
let connectionsFetches = 0;
const sent: { path: string; method: string; body: unknown }[] = [];
let connections: Record<string, unknown>[] = [];
/** The Recorder's answers: what a ping and a connect message get, or undefined for no extension. */
let recorder:
  | {
      ping: Record<string, unknown>;
      connect: Record<string, unknown>;
    }
  | undefined;
const messages: { id: string; message: unknown }[] = [];
const globals = globalThis as { chrome?: unknown };
let hadChrome = false;
let savedChrome: unknown;

function connection(over: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    label: "Chrome on Mac",
    via: "web",
    extensionId: EXTENSION_ID,
    installId: THIS_COPY,
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    lastUsedAt: null,
    ...over,
  };
}

beforeEach(() => {
  queryClient.clear();
  sent.length = 0;
  messages.length = 0;
  connections = [];
  connectionsFail = false;
  connectionsFetches = 0;
  recorder = undefined;
  hadChrome = "chrome" in globals;
  savedChrome = globals.chrome;
  globals.chrome = {
    runtime: {
      sendMessage: (
        id: string,
        message: unknown,
        reply: (answer: unknown) => void,
      ) => {
        messages.push({ id, message });
        if (!recorder) {
          // Chrome's answer for an id that is not installed.
          (
            globals.chrome as { runtime: { lastError?: unknown } }
          ).runtime.lastError = { message: "Could not establish connection." };
          reply(undefined);
          return;
        }
        const type = (message as { type: string }).type;
        reply(type === "openbot.ping" ? recorder.ping : recorder.connect);
      },
    },
  };
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({
          path: url,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (url === "/api/recorder/connect-codes")
          return Response.json(
            { code: "obc_x", expiresAt: new Date().toISOString() },
            { status: 201 },
          );
        if (method === "DELETE") {
          const id = url.split("/").pop();
          connections = connections.filter((c) => c.id !== id);
          return new Response(null, { status: 204 });
        }
      }
      if (url === "/api/recorder/connections") {
        connectionsFetches += 1;
        if (connectionsFail) return new Response(null, { status: 500 });
      }
      if (url === "/api/recorder/connections")
        return Response.json({ connections, extensionIds: [EXTENSION_ID] });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  if (hadChrome) globals.chrome = savedChrome;
  else delete globals.chrome;
});

function draw(screen = <ThisBrowser />) {
  return render(
    <QueryClientProvider client={queryClient}>{screen}</QueryClientProvider>,
  );
}

test("without the Recorder the row says so and offers no button or link", async () => {
  const view = draw();
  await view.findByText(
    "The OpenBot Recorder isn't installed in this browser.",
  );
  expect(view.queryByRole("button")).toBeNull();
  expect(view.queryByRole("link")).toBeNull();
});

test("Connect sends the code to the detected Recorder and asks for confirmation there", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: true, installId: THIS_COPY, awaitingConfirmation: true },
  };
  const view = draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Connect this browser" }),
  );
  await view.findByText("Confirm in the OpenBot Recorder tab that opened.");
  expect(sent).toContainEqual({
    path: "/api/recorder/connect-codes",
    method: "POST",
    body: { via: "web" },
  });
  expect(messages).toContainEqual({
    id: EXTENSION_ID,
    message: { type: "openbot.connect", code: "obc_x" },
  });
});

test("a new connection with the install id the connect answer carried switches the row to Connected", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: true, installId: THIS_COPY, awaitingConfirmation: true },
  };
  const view = draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Connect this browser" }),
  );
  await view.findByText("Confirm in the OpenBot Recorder tab that opened.");
  connections = [connection()];
  await view.findByText("Connected", {}, { timeout: 4000 });
  expect(view.queryByRole("button")).toBeNull();
});

test("a connection from another copy (Chrome connected, this is Edge) neither shows Connected nor ends the wait", async () => {
  connections = [connection({ installId: OTHER_COPY })];
  recorder = {
    ping: { ok: true },
    connect: { ok: true, installId: THIS_COPY, awaitingConfirmation: true },
  };
  const view = draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Connect this browser" }),
  );
  await view.findByText("Confirm in the OpenBot Recorder tab that opened.");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  expect(view.queryByText("Connected")).toBeNull();
  expect(
    view.getByText("Confirm in the OpenBot Recorder tab that opened."),
  ).toBeTruthy();
});

test("a copy that answers the ping with its install id and a matching connection reads Connected", async () => {
  connections = [connection()];
  recorder = {
    ping: { ok: true, installId: THIS_COPY },
    connect: { ok: true },
  };
  const view = draw();
  await view.findByText("Connected");
});

test("a pinned-elsewhere refusal shows its sentence", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: false, error: "pinned-elsewhere" },
  };
  const view = draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Connect this browser" }),
  );
  await view.findByText(
    "Your organization set the Recorder to another OpenBot.",
  );
});

test("a throttled connect says plainly when to try again, not that another request is under way", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: false, error: "throttled", retryAfterMs: 6.5 * 60_000 },
  };
  const view = draw();
  const button = await view.findByRole("button", {
    name: "Connect this browser",
  });
  fireEvent.click(button);
  await view.findByText(
    "Too many connect requests in a short time. Try again in 7 minutes.",
  );
  expect(view.queryByText(/finishing another connect request/)).toBeNull();

  // Under a minute left reads as one minute, never zero.
  recorder.connect = { ok: false, error: "throttled", retryAfterMs: 20_000 };
  fireEvent.click(button);
  await view.findByText(
    "Too many connect requests in a short time. Try again in 1 minute.",
  );
});

test("a connect the Recorder is still finishing keeps its own sentence", async () => {
  recorder = { ping: { ok: true }, connect: { ok: false, error: "busy" } };
  const view = draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Connect this browser" }),
  );
  await view.findByText(
    "The Recorder is finishing another connect request. Try again in a moment.",
  );
});

test("an answer with no sentence of its own still gets one", async () => {
  recorder = { ping: { ok: true }, connect: { ok: false, error: "invalid" } };
  const view = draw();
  fireEvent.click(
    await view.findByRole("button", { name: "Connect this browser" }),
  );
  await view.findByText("The Recorder didn't accept the request. Try again.");
});

test("the OpenBot browser's connection says it is the person's OpenBot browser", async () => {
  connections = [
    connection({
      id: "conn-2",
      label: "OpenBot browser",
      via: "openbot-browser",
      installId: "b".repeat(32),
    }),
  ];
  const view = draw(<ConnectedBrowsers />);
  await view.findByText("OpenBot browser");
  const at = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(String(connections[0]?.createdAt)));
  expect(
    view.getByText(`Your OpenBot browser, connected ${at}, never used`),
  ).toBeTruthy();
});

test("Disconnect sends the DELETE and the row disappears", async () => {
  connections = [connection()];
  const view = draw(<ConnectedBrowsers />);
  await view.findByText("Chrome on Mac");
  const at = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(String(connections[0]?.createdAt)));
  expect(
    view.getByText(`Connected ${at} from OpenBot, never used`),
  ).toBeTruthy();
  fireEvent.click(
    view.getByRole("button", { name: "Disconnect Chrome on Mac" }),
  );
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/recorder/connections/conn-1",
      method: "DELETE",
      body: undefined,
    }),
  );
  await view.findByText("No browsers connected yet.");
  expect(view.queryByText("Chrome on Mac")).toBeNull();
});

test("when the connections cannot be loaded This browser says it cannot tell, and is not empty", async () => {
  connectionsFail = true;
  const view = draw();
  await view.findByText(
    "Couldn't check whether this browser is connected. Reload the page.",
    {},
    { timeout: 4000 },
  );
  expect(view.getByRole("alert")).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
});

test("a connect request nobody confirms expires after five minutes and stops polling", async () => {
  recorder = {
    ping: { ok: true },
    connect: { ok: true, installId: THIS_COPY, awaitingConfirmation: true },
  };
  // Capture the five-minute timers (the expiry, and the query cache's own 5-minute gc) so the test can fire them instead of waiting.
  const realSetTimeout = globalThis.setTimeout;
  const expiries: (() => void)[] = [];
  globalThis.setTimeout = ((
    handler: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 5 * 60_000) {
      expiries.push(handler);
      return 0;
    }
    return realSetTimeout(handler, delay, ...args);
  }) as unknown as typeof setTimeout;
  try {
    const view = draw();
    fireEvent.click(
      await view.findByRole("button", { name: "Connect this browser" }),
    );
    await view.findByText("Confirm in the OpenBot Recorder tab that opened.");
    expect(expiries.length).toBeGreaterThan(0);
    const polling = connectionsFetches;
    await new Promise((resolve) => realSetTimeout(resolve, 2500));
    expect(connectionsFetches).toBeGreaterThan(polling);
    act(() => {
      for (const fire of expiries) fire();
    });
    await view.findByText("The request expired. Try again.");
    const stopped = connectionsFetches;
    await new Promise((resolve) => realSetTimeout(resolve, 2500));
    expect(connectionsFetches).toBe(stopped);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}, 15_000);

test("the copy in this browser is marked among connected browsers that share a name, and each row says when it connected", async () => {
  // End-to-end run 6: three rows all read "Google Chrome on macOS" (three Chrome profiles), and none said which one was
  // the browser the page was open in.
  const hour = 3_600_000;
  connections = [
    connection({
      id: "conn-1",
      label: "Google Chrome on macOS",
      installId: OTHER_COPY,
      createdAt: new Date(Date.now() - 30 * hour).toISOString(),
      lastUsedAt: new Date(Date.now() - 5 * hour).toISOString(),
    }),
    connection({
      id: "conn-2",
      label: "Google Chrome on macOS",
      installId: "e".repeat(32),
      createdAt: new Date(Date.now() - 2 * hour - 60_000).toISOString(),
      lastUsedAt: new Date(Date.now() - 2 * hour).toISOString(),
    }),
    connection({
      id: "conn-3",
      label: "Google Chrome on macOS",
      installId: THIS_COPY,
      createdAt: new Date(Date.now() - 2 * hour).toISOString(),
      lastUsedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    }),
  ];
  // A connected copy answers the ping with its install id.
  recorder = {
    ping: { ok: true, installId: THIS_COPY },
    connect: { ok: true },
  };
  const view = draw(<BrowserSections />);
  await view.findByText("Google Chrome on macOS · This browser");
  expect(view.getAllByText("Google Chrome on macOS")).toHaveLength(2);
  expect(
    view.getByRole("button", {
      name: "Disconnect Google Chrome on macOS · This browser",
    }),
  ).toBeTruthy();
  // Two copies connected two hours ago, a minute apart, read differently.
  const descriptions = view
    .getAllByText(/^Connected .* from OpenBot, last used /)
    .map((element) => element.textContent);
  expect(new Set(descriptions).size).toBe(3);
});
