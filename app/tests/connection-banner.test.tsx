/**
 * The line that says the OpenBot this window is connected to can't be reached.
 *
 * Inside OpenBot Desktop connected to an OpenBot that runs somewhere else, the page is served by the
 * desktop app's relay on this computer, which carries every request on. When that OpenBot does not
 * answer, the relay answers the page itself: a 502, text/plain, "OpenBot could not be reached."
 * (desktop/src-tauri/src/connected/relay.rs, `unreachable`). The network here answers exactly that,
 * or what OpenBot answers. The desktop app stands in at `window.__TAURI_INTERNALS__`, answering the
 * `connection` call as its plugin does; the component, the client and the requests are the real ones.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { tryClient } from "@/lib/client";
import { queryClient } from "@/query-client";

const LINE =
  "Can't reach openbot.example.com. OpenBot will reconnect when it answers.";

/** Whether the OpenBot at the typed address answers. */
let openbot: "answers" | "unreachable";
let shellCalls: string[];
let fetches: string[];
const originalFetch = globalThis.fetch;

/** What the relay answers the page when the OpenBot it carries to does not answer. */
function relayUnreachable(): Response {
  return new Response("OpenBot could not be reached.", {
    status: 502,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function inDesktop(connection: { mode: string; address: string | null }) {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      shellCalls.push(command);
      if (command === "plugin:openbot-desktop|connection") return connection;
      throw `command ${command} not found`;
    },
    transformCallback: () => 0,
  };
}

/**
 * A request of the page's own through the client, as a write makes one. Not a read: while the line
 * shows, reads wait for OpenBot (`connection-lost-screens.test.tsx`).
 */
async function aScreenAsks() {
  await act(async () => {
    await tryClient("/api/v2/organizations/default/deployment").catch(
      () => undefined,
    );
  });
}

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:53111/" }));
beforeEach(async () => {
  shellCalls = [];
  fetches = [];
  openbot = "answers";
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return openbot === "answers"
        ? Response.json({ edition: "team" })
        : relayUnreachable();
    },
    { preconnect: originalFetch.preconnect },
  );
  // Whatever an earlier test left, the last request here was answered.
  await aScreenAsks();
  queryClient.clear();
  fetches = [];
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectionBanner />
    </QueryClientProvider>,
  );
}

test("connected, and the OpenBot can't be reached: one line names its address", async () => {
  inDesktop({ mode: "connected", address: "https://openbot.example.com" });
  const view = show();
  await waitFor(() =>
    expect(shellCalls).toContain("plugin:openbot-desktop|connection"),
  );
  expect(view.queryByRole("complementary", { name: "Connection" })).toBeNull();

  openbot = "unreachable";
  await aScreenAsks();
  const line = await view.findByRole("complementary", { name: "Connection" });
  expect(line.textContent).toBe(LINE);
});

test("the line clears on the next request OpenBot answers", async () => {
  inDesktop({ mode: "connected", address: "https://openbot.example.com" });
  openbot = "unreachable";
  const view = show();
  await aScreenAsks();
  await view.findByRole("complementary", { name: "Connection" });

  openbot = "answers";
  await aScreenAsks();
  await waitFor(() =>
    expect(
      view.queryByRole("complementary", { name: "Connection" }),
    ).toBeNull(),
  );
});

test("while it shows, it asks OpenBot itself, so it clears on a screen with nothing more to ask", async () => {
  inDesktop({ mode: "connected", address: "https://openbot.example.com" });
  openbot = "unreachable";
  const view = show();
  await aScreenAsks();
  await view.findByRole("complementary", { name: "Connection" });
  const asked = fetches.length;

  openbot = "answers";
  await waitFor(
    () =>
      expect(
        view.queryByRole("complementary", { name: "Connection" }),
      ).toBeNull(),
    { timeout: 8_000 },
  );
  // One check, at OpenBot's cheapest public address, not a loop.
  expect(fetches.slice(asked)).toEqual([
    "/api/v2/organizations/default/deployment",
  ]);
}, 15_000);

test("a 502 passed on from beyond the relay is the address answering, and clears the line", async () => {
  inDesktop({ mode: "connected", address: "https://openbot.example.com" });
  openbot = "unreachable";
  const view = show();
  await aScreenAsks();
  await view.findByRole("complementary", { name: "Connection" });

  // Its own gateway answering for it: that address is up, whatever broke behind it.
  globalThis.fetch = Object.assign(
    async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    { preconnect: originalFetch.preconnect },
  );
  await aScreenAsks();
  await waitFor(() =>
    expect(
      view.queryByRole("complementary", { name: "Connection" }),
    ).toBeNull(),
  );
});

test("OpenBot Desktop running OpenBot on this computer draws no line", async () => {
  inDesktop({ mode: "local", address: null });
  openbot = "unreachable";
  const view = show();
  await aScreenAsks();
  await waitFor(() =>
    expect(shellCalls).toContain("plugin:openbot-desktop|connection"),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByRole("complementary", { name: "Connection" })).toBeNull();
});

test("a browser, with no desktop app around the page, draws no line and asks no shell", async () => {
  openbot = "unreachable";
  const view = show();
  await aScreenAsks();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByRole("complementary", { name: "Connection" })).toBeNull();
  expect(shellCalls).toEqual([]);
});
