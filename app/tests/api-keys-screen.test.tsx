import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { ApiKeysPage } from "@/components/settings/api-keys";
import {
  getApiKeysMock,
  getCreateApiKeyMockHandler,
  getCreateApiKeyResponseMock,
  getDeleteApiKeyMockHandler,
  getListApiKeysMockHandler,
  getListApiKeysResponseMock,
} from "@/lib/api/generated/api-keys/api-keys.msw";
import type { ApiKey } from "@/lib/api/generated/model";
import { queryClient as appQueryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings → API keys, against the spec's own server.
 *
 * The MSW handlers are the ones Orval generates beside the client, answering at the API's addresses
 * with the spec's examples, and the screen is the real one. A request anywhere else is not found, so
 * a hand-written address cannot pass.
 */

const requests: string[] = [];
const server = setupServer(
  ...getApiKeysMock(),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", ({ request }) => {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}${url.search}`);
});

const KEYS = "/api/v2/organizations/default/people/me/api-keys";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  requests.length = 0;
  // The screen's writes invalidate through the app's one client; nothing is left in it for the next test.
  appQueryClient.clear();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw() {
  const rootRoute = createRootRoute();
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/api-keys",
        component: ApiKeysPage,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/settings/api-keys"] }),
  });
  return render(
    <QueryClientProvider client={appQueryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** A problem answer, as the API writes one. */
function problem(status: number, code: string, detail: string) {
  return HttpResponse.json(
    {
      type: "https://open.bot/errors/example",
      title: detail,
      status,
      detail,
      code,
      category: "permission",
      retryable: false,
      requestId: "req_example",
      traceId: "trace_example",
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

test("lists the person's keys with when each was made, last used and expires", async () => {
  const [example] = getListApiKeysResponseMock().apiKeys;
  const never: ApiKey = {
    id: "9f8e7d6c5b4a3210",
    name: "Laptop script",
    start: "obk_Qr",
    createdAt: "2026-11-01T10:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
  };
  server.use(
    getListApiKeysMockHandler({ apiKeys: [example, never], nextCursor: null }),
  );
  const view = draw();

  const used = (await view.findByText("Nightly report")).closest(
    '[data-slot="item"]',
  );
  expect(used?.textContent).toContain("obk_Xy");
  expect(used?.textContent).toContain("Created Nov 14, 2026");
  expect(used?.textContent).toMatch(/Last used .+ ago|Last used/);
  expect(used?.textContent).toContain("Expires Feb 12, 2027");

  const unused = view.getByText("Laptop script").closest('[data-slot="item"]');
  expect(unused?.textContent).toContain("Never used");
  expect(unused?.textContent).not.toContain("Expires");

  expect(requests).toContain(`GET ${KEYS}?limit=100`);
});

/*
 * REPORTED: a script used a key and the screen still said "Never used". The API records the use at
 * once; the screen was drawing the list it had read before. Coming back to it asks again.
 */
function keysUsedAfterTheFirstRead() {
  const [example] = getListApiKeysResponseMock().apiKeys;
  let used = false;
  server.use(
    getListApiKeysMockHandler(() => ({
      apiKeys: [
        {
          ...example,
          lastUsedAt: used ? new Date().toISOString() : null,
        },
      ],
      nextCursor: null,
    })),
  );
  return () => {
    used = true;
  };
}

const lastUsedLine = (view: ReturnType<typeof render>) =>
  view.getByText("Nightly report").closest('[data-slot="item"]')?.textContent;

test("coming back to the window asks for the list again, so a key's last use shows", async () => {
  const useKey = keysUsedAfterTheFirstRead();
  const view = draw();
  await view.findByText("Nightly report");
  expect(lastUsedLine(view)).toContain("Never used");

  useKey();
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });

  await waitFor(() => expect(lastUsedLine(view)).toContain("Last used"));
  expect(
    requests.filter((line) => line === `GET ${KEYS}?limit=100`),
  ).toHaveLength(2);
});

test("opening the screen again asks for the list again, so a key's last use shows", async () => {
  const useKey = keysUsedAfterTheFirstRead();
  const first = draw();
  await first.findByText("Nightly report");
  expect(lastUsedLine(first)).toContain("Never used");
  first.unmount();

  useKey();
  const again = draw();

  await waitFor(() => expect(lastUsedLine(again)).toContain("Last used"));
  expect(
    requests.filter((line) => line === `GET ${KEYS}?limit=100`),
  ).toHaveLength(2);
});

test("reads every page of the list", async () => {
  const [example] = getListApiKeysResponseMock().apiKeys;
  server.use(
    getListApiKeysMockHandler(({ request }) =>
      new URL(request.url).searchParams.get("cursor") === "bmV4dA"
        ? {
            apiKeys: [{ ...example, id: "second", name: "Second page key" }],
            nextCursor: null,
          }
        : { apiKeys: [example], nextCursor: "bmV4dA" },
    ),
  );
  const view = draw();

  await view.findByText("Second page key");
  expect(view.getByText("Nightly report")).toBeTruthy();
  expect(requests).toContain(`GET ${KEYS}?limit=100&cursor=bmV4dA`);
});

test("with no keys it says so and offers to create one", async () => {
  server.use(getListApiKeysMockHandler({ apiKeys: [], nextCursor: null }));
  const view = draw();

  await view.findByText("No API keys yet");
  expect(
    view.getAllByRole("button", { name: "Create key" }).length,
  ).toBeGreaterThan(0);
});

test("creating a key sends its name with an Idempotency-Key, shows the key once with Copy, and it is gone after Done", async () => {
  const sent: { key: string; body: unknown }[] = [];
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
  server.use(
    getCreateApiKeyMockHandler(async ({ request }) => {
      sent.push({
        key: request.headers.get("idempotency-key") ?? "",
        body: await request.json(),
      });
      return getCreateApiKeyResponseMock();
    }),
  );
  const secret = getCreateApiKeyResponseMock().key;
  const view = draw();
  await view.findByText("Nightly report");

  fireEvent.click(view.getByRole("button", { name: "Create key" }));
  const name = await view.findByLabelText("Name");
  // Typed, not set: the box is a Base UI input, which reads keystrokes and not a `change` event.
  await userEvent.type(name, "  Deploy script ");
  fireEvent.submit(name.closest("form") as HTMLFormElement);

  // The key, whole, once.
  await view.findByText(secret);
  expect(view.getByText(/can't see it again/)).toBeTruthy();
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toEqual({ name: "Deploy script" });
  expect(sent[0].key).toMatch(/^[0-9a-f]{32}$/);
  expect(requests).toContain(`POST ${KEYS}`);

  fireEvent.click(view.getByRole("button", { name: "Copy" }));
  await view.findByRole("button", { name: "Copied" });
  expect(copied).toEqual([secret]);

  fireEvent.click(view.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(view.queryByText(secret)).toBeNull());
  expect(document.body.textContent).not.toContain(secret);
  // Nothing the app keeps holds it either.
  expect(JSON.stringify(appQueryClient.getQueryCache().getAll())).not.toContain(
    secret,
  );
  expect(
    JSON.stringify(
      appQueryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    ),
  ).not.toContain(secret);
});

test("a name is needed before a key is made", async () => {
  const view = draw();
  await view.findByText("Nightly report");

  fireEvent.click(view.getByRole("button", { name: "Create key" }));
  const name = await view.findByLabelText("Name");
  fireEvent.submit(name.closest("form") as HTMLFormElement);

  await settleReactWork();
  expect(requests.filter((line) => line.startsWith("POST"))).toEqual([]);
});

test("revoking asks first, then deletes the key and its row goes", async () => {
  let keys = getListApiKeysResponseMock().apiKeys;
  const deleted: { id: string; key: string }[] = [];
  server.use(
    getListApiKeysMockHandler(() => ({ apiKeys: keys, nextCursor: null })),
    getDeleteApiKeyMockHandler(({ request, params }) => {
      deleted.push({
        id: String(params.apiKeyId),
        key: request.headers.get("idempotency-key") ?? "",
      });
      keys = keys.filter((key) => key.id !== params.apiKeyId);
    }),
  );
  const view = draw();
  await view.findByText("Nightly report");

  fireEvent.click(view.getByRole("button", { name: "Revoke Nightly report" }));
  // Asked first: nothing is deleted by the row's button.
  await view.findByText("Revoke Nightly report?");
  expect(deleted).toEqual([]);

  fireEvent.click(view.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(view.queryByText("Nightly report")).toBeNull());
  expect(deleted).toHaveLength(1);
  expect(deleted[0].id).toBe("4b2c9e71d0a84f6b");
  expect(deleted[0].key).toMatch(/^[0-9a-f]{32}$/);
  expect(requests).toContain(`DELETE ${KEYS}/4b2c9e71d0a84f6b`);
  await view.findByText("No API keys yet");
});

test("an OpenBot with no sign-in says it has no API keys, in a sentence and not as an error", async () => {
  server.use(
    http.get(`*${KEYS}`, () =>
      problem(
        503,
        "SIGN_IN_UNAVAILABLE",
        "This OpenBot signs nobody in, so it has no API keys.",
      ),
    ),
  );
  const view = draw();

  await view.findByText("API keys aren't available on this OpenBot");
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Create key" })).toBeNull();
});

test("any other 503 is a failure to load, not the missing feature", async () => {
  server.use(
    http.get(
      `*${KEYS}`,
      () => new HttpResponse("bad gateway", { status: 503 }),
    ),
  );
  const view = draw();

  // The app's client tries a failed read once more before it says so.
  const alert = await view.findByRole("alert", {}, { timeout: 4000 });
  expect(alert.textContent).toContain("Couldn't load your API keys.");
});

test("refused for not being signed in on the web, in a browser it says where to create keys", async () => {
  server.use(
    http.get(`*${KEYS}`, () =>
      problem(
        403,
        "PERMISSION_DENIED",
        "An API key or an app can't manage API keys or sessions. Sign in to OpenBot to do this.",
      ),
    ),
  );
  const view = draw();

  await view.findByText("Create API keys from OpenBot in your browser.");
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Create key" })).toBeNull();
  expect(view.queryByRole("button", { name: "Open in browser" })).toBeNull();
});

test("refused in OpenBot Desktop, a link opens this page at the OpenBot it is connected to, in the person's browser", async () => {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string) => {
      if (command === "plugin:openbot-desktop|connection")
        return {
          mode: "connected",
          address: "https://openbot.northwind.example",
        };
      throw `command ${command} not found`;
    },
  };
  server.use(
    http.get(`*${KEYS}`, () =>
      problem(
        403,
        "PERMISSION_DENIED",
        "An API key or an app can't manage API keys or sessions. Sign in to OpenBot to do this.",
      ),
    ),
  );
  const view = draw();

  await view.findByText("Create API keys from OpenBot in your browser.");
  // A link for a new tab, which the desktop window hands to the person's own browser. Its address
  // is the OpenBot's own, never the window's, which only the desktop app can use.
  const link = await view.findByRole("button", { name: "Open in browser" });
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe(
    "https://openbot.northwind.example/settings/api-keys",
  );
  expect(link.getAttribute("target")).toBe("_blank");
});
