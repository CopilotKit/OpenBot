/**
 * Settings → AI providers: several AI connections at once (plans/multiple-ai-connections-spec.md,
 * step 2), each on a page of its own (`openbot-screen-layout`, Screens, Not Dialogs).
 *
 * The list (the organization's, and a person's own on OpenBot Cloud) has one row per connection,
 * each a link to its page, tags the default once there are two, and links to the page that connects
 * another. A provider's page makes it the default, changes it and disconnects it. Against a server
 * older than the list (404) the section draws the one row it drew before.
 *
 * `fetch` is a fake of the API at /api/v2/organizations/default: every answer is parsed with the
 * generated response schema and every body with the generated request schema, so a request the
 * spec doesn't allow fails here as it would against the server.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AiConnection,
  AiConnectionEntry,
  AiConnectionProvider,
  PersonalAiConnection,
} from "@/lib/api/generated/model";
import {
  ConnectAiConnectionBody,
  ConnectAiConnectionResponse,
  GetAiConnectionResponse,
  GetPersonalAiConnectionResponse,
  ListAiConnectionsResponse,
  MakeAiConnectionDefaultResponse,
  StartAiSignInBody,
} from "@/lib/api/generated/models/models.zod";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";
import { vendoredMarkFor } from "./vendored-marks";

mock.module("@/lib/marks", () => ({ markFor: vendoredMarkFor }));
const {
  ChangeProviderPage,
  ConnectProviderPage,
  ProviderPage,
  ProvidersSettingsPage,
} = await import("@/components/settings/provider-pages");
const { providerSearch, scopeOf } = await import("@/lib/ai-connection/paths");
const { reconnectPath } = await import(
  "@/components/channels/stopped-connection-notice"
);

const NativeResponse = globalThis.Response;
const ORG = "/api/v2/organizations/default";

function entry(
  provider: AiConnectionProvider,
  overrides: Partial<AiConnectionEntry> = {},
): AiConnectionEntry {
  return {
    id: provider,
    provider,
    login: provider === "anthropic" ? "plan" : "api-key",
    model: null,
    endpointHost: null,
    isDefault: false,
    ready: true,
    problem: null,
    connectedAt: "2026-11-20T09:00:00.000Z",
    ...overrides,
  };
}

const ORG_CONNECTION: AiConnection = {
  provider: "anthropic",
  login: "plan",
  model: null,
  endpointHost: null,
  keySet: false,
  ready: true,
  source: "stored",
  editable: true,
  saved: [],
  changedAt: "2026-11-20T09:00:00.000Z",
};

/** The person's own AI on OpenBot Cloud, available. */
const PERSONAL: PersonalAiConnection = {
  connection: { ...ORG_CONNECTION, editable: true },
  organization: { ready: false, provider: null },
  uses: "personal",
  required: true,
  available: true,
  signIns: ["openai", "anthropic"],
};

type Call = { method: string; path: string; body?: unknown };

let calls: Call[];
/** The organization's list, or null for a server older than it (404). */
let orgList: AiConnectionEntry[] | null;
let orgSignIns: AiConnectionProvider[];
/** The person's own list, or null for 404. */
let personalList: AiConnectionEntry[] | null;
let personal: PersonalAiConnection | null;
/** Set: make-default is refused (409) because the connection stopped since the list was read. */
let stopsBeforeMakeDefault: AiConnectionEntry["problem"];
/** How long the person's AI takes to answer: a real server's reads after a change aren't all as quick. */
let personalDelay: number;

function json(status: number, body: unknown) {
  return new NativeResponse(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notFound() {
  return new NativeResponse(
    JSON.stringify({
      type: "https://open.bot/errors/not-found",
      title: "Not found.",
      status: 404,
      detail: "Not found.",
      code: "NOT_FOUND",
    }),
    { status: 404, headers: { "content-type": "application/problem+json" } },
  );
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
    "http://127.0.0.1:3010",
  );
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  const body =
    typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ method, path, body });
  if (path === `${ORG}/ai-connection` && method === "GET")
    return json(200, GetAiConnectionResponse.parse(ORG_CONNECTION));
  if (path === `${ORG}/people/me/ai-connection` && method === "GET") {
    if (personalDelay > 0)
      await new Promise((done) => setTimeout(done, personalDelay));
    return personal
      ? json(200, GetPersonalAiConnectionResponse.parse(personal))
      : notFound();
  }
  const listOf = (scope: "org" | "personal") =>
    scope === "org" ? orgList : personalList;
  for (const [scope, base] of [
    ["org", `${ORG}/ai-connections`],
    ["personal", `${ORG}/people/me/ai-connections`],
  ] as const) {
    const list = listOf(scope);
    if (path === base && method === "GET")
      return list
        ? json(
            200,
            ListAiConnectionsResponse.parse({
              connections: list,
              nextCursor: null,
              signIns: scope === "org" ? orgSignIns : PERSONAL.signIns,
            }),
          )
        : notFound();
    if (path === base && method === "POST") {
      const input = ConnectAiConnectionBody.parse(body);
      // As the server answers: a provider already connected keeps its id and whether it is the default.
      const added = entry(input.provider, {
        login: input.login,
        isDefault:
          list?.find((one) => one.provider === input.provider)?.isDefault ??
          (list ?? []).length === 0,
      });
      // One per provider: connecting one already there replaces it.
      if (list) {
        const at = list.findIndex((one) => one.provider === input.provider);
        if (at >= 0) list.splice(at, 1, added);
        else list.push(added);
      }
      return json(201, ConnectAiConnectionResponse.parse(added));
    }
    const makeDefault = new RegExp(`^${base}/([^/]+)/make-default$`).exec(path);
    if (makeDefault && method === "POST" && list) {
      const id = decodeURIComponent(makeDefault[1] ?? "");
      if (stopsBeforeMakeDefault) {
        const stopping = list.find((connection) => connection.id === id);
        if (stopping)
          Object.assign(stopping, {
            ready: false,
            problem: stopsBeforeMakeDefault,
          });
        return new NativeResponse(
          JSON.stringify({
            type: "https://open.bot/errors/conflict",
            title: "Conflict.",
            status: 409,
            detail: "That connection can't run now.",
            code: "AI_CONNECTION_NOT_READY",
          }),
          {
            status: 409,
            headers: { "content-type": "application/problem+json" },
          },
        );
      }
      for (const connection of list)
        connection.isDefault = connection.id === id;
      const made = list.find((connection) => connection.id === id);
      return json(200, MakeAiConnectionDefaultResponse.parse(made));
    }
    const one = new RegExp(`^${base}/([^/]+)$`).exec(path);
    if (one && method === "DELETE" && list) {
      const id = decodeURIComponent(one[1] ?? "");
      const at = list.findIndex((connection) => connection.id === id);
      if (at >= 0) list.splice(at, 1);
      return new NativeResponse(null, { status: 204 });
    }
  }
  if (path === `${ORG}/ai-connection-sign-ins` && method === "POST") {
    StartAiSignInBody.parse(body);
    return json(201, {
      id: "sign-in-1",
      provider: "anthropic",
      url: "https://claude.com/cai/oauth/authorize?state=example",
      userCode: null,
      expiresAt: "2026-11-23T10:00:00.000Z",
      interval: 5,
      finish: "code",
    });
  }
  return notFound();
}

const originalFetch = global.fetch;

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" }));
beforeEach(() => {
  calls = [];
  orgList = null;
  orgSignIns = [];
  personalList = null;
  personal = null;
  stopsBeforeMakeDefault = null;
  personalDelay = 0;
  global.fetch = Object.assign(fakeFetch, {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch;
  window.open = (() => null) as typeof window.open;
  window.history.replaceState(null, "", "/settings/providers");
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/** The AI providers screens at `path`, as Settings routes them. */
function renderAt(path: string) {
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/settings/providers",
    component: ProvidersSettingsPage,
  });
  const connect = createRoute({
    getParentRoute: () => root,
    path: "/settings/providers/new",
    validateSearch: providerSearch,
    component: function Connect() {
      return <ConnectProviderPage scope={scopeOf(connect.useSearch())} />;
    },
  });
  const one = createRoute({
    getParentRoute: () => root,
    path: "/settings/providers/$provider",
    validateSearch: providerSearch,
    component: function One() {
      const { provider } = one.useParams();
      // The test's own router isn't the app's registered one: read the search as the app's does.
      const search = providerSearch(one.useSearch() as Record<string, unknown>);
      return (
        <ProviderPage
          connected={search.connected}
          id={provider}
          scope={scopeOf(search)}
        />
      );
    },
  });
  const change = createRoute({
    getParentRoute: () => root,
    path: "/settings/providers/$provider/change",
    validateSearch: providerSearch,
    component: function Change() {
      const { provider } = change.useParams();
      return (
        <ChangeProviderPage id={provider} scope={scopeOf(change.useSearch())} />
      );
    },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([list, connect, one, change]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

const writes = () => calls.filter((call) => call.method !== "GET");
const at = (router: ReturnType<typeof renderAt>["router"]) =>
  `${router.state.location.pathname}${router.state.location.searchStr}`;

test("404 for the list draws today's single row, for the organization", async () => {
  const { view } = renderAt("/settings/providers");
  await view.findByText("Anthropic");
  expect(view.queryByText("Connect another AI")).toBeNull();
  expect(calls.some((call) => call.path === `${ORG}/ai-connections`)).toBe(
    true,
  );
});

test("404 for the list draws today's single row, for a person's own AI", async () => {
  personal = PERSONAL;
  const { view } = renderAt("/settings/providers");
  await view.findByText("Your AI");
  expect((await view.findAllByText("Anthropic")).length).toBeGreaterThan(0);
  expect(view.queryByText("Connect another AI")).toBeNull();
  expect(view.queryByText("Connect your AI")).toBeNull();
});

test("one connection: one row, no Default tag, and Connect another AI", async () => {
  orgList = [entry("anthropic", { isDefault: true })];
  const { view } = renderAt("/settings/providers");
  await view.findByText("Claude plan");
  const add = view.getByRole("link", { name: /Connect another AI/ });
  expect(add.getAttribute("href")).toBe("/settings/providers/new");
  expect(view.queryByText("Default")).toBeNull();
});

test("each row is a link to its provider's page, a person's own named as theirs", async () => {
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  personal = PERSONAL;
  personalList = [entry("anthropic", { isDefault: true })];
  const { view } = renderAt("/settings/providers");
  await view.findByText("Organization's AI");
  await view.findByRole("link", { name: /OpenAI API key/ });
  const hrefs = view
    .getAllByRole("link", { name: /Claude plan|OpenAI API key/ })
    .map((link) => link.getAttribute("href"));
  expect(hrefs.sort()).toEqual([
    "/settings/providers/anthropic",
    "/settings/providers/anthropic?owner=personal",
    "/settings/providers/openai",
  ]);
  // No dialog anywhere on these screens.
  expect(view.queryByRole("dialog")).toBeNull();
});

test("a conversation's Reconnect leads to the same pages", () => {
  expect(reconnectPath("openai")).toBe("/settings/providers/openai");
  expect(reconnectPath("anthropic", "personal")).toBe(
    "/settings/providers/anthropic?owner=personal",
  );
  expect(reconnectPath("anthropic", "organization")).toBe(
    "/settings/providers/anthropic",
  );
});

test("two connections: the default is tagged, and Make default on the other's page sends makeAiConnectionDefault", async () => {
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("openai", { connectedAt: "2026-11-21T09:00:00.000Z" }),
  ];
  const user = userEvent.setup({ document });
  const { view, router } = renderAt("/settings/providers");
  const claude = await view.findByRole("link", { name: /Claude plan/ });
  expect(within(claude).getByText("Default")).toBeDefined();
  await user.click(view.getByRole("link", { name: /OpenAI API key/ }));
  await view.findByRole("heading", { name: "OpenAI API key" });
  expect(at(router)).toBe("/settings/providers/openai");
  await user.click(view.getByRole("button", { name: "Make default" }));
  await waitFor(() =>
    expect(writes()).toEqual([
      { method: "POST", path: `${ORG}/ai-connections/openai/make-default` },
    ]),
  );
});

test("a refused Make default reads the list again, so the page shows the connection stopped", async () => {
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  stopsBeforeMakeDefault = {
    code: "key-refused",
    detail: "OpenAI refused the key.",
  };
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/openai");
  await user.click(await view.findByRole("button", { name: "Make default" }));
  expect(await view.findByText("OpenAI refused the key.")).toBeDefined();
  await waitFor(() =>
    expect(
      (view.getByRole("button", { name: "Make default" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
});

test("disconnecting the default asks on its page which takes over, and sends make-default before the remove", async () => {
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("openai"),
    entry("google", { login: "endpoint", model: "gemini-3.8-flash" }),
  ];
  const user = userEvent.setup({ document });
  const { view, router } = renderAt("/settings/providers/anthropic");
  await view.findByText(
    "It's the default AI. Choose which one Bots use when nobody picked a model.",
  );
  const google = view.getByRole("radio", { name: /Google Gemini API key/ });
  // In the app's colours, as the Bot's default-model choice draws its radios, not the browser's blue.
  expect(google.className).toContain("accent-foreground");
  await user.click(google);
  await user.click(view.getByRole("button", { name: "Disconnect" }));
  await waitFor(() =>
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${ORG}/ai-connections/google/make-default`,
      `DELETE ${ORG}/ai-connections/anthropic`,
    ]),
  );
  await waitFor(() => expect(at(router)).toBe("/settings/providers"));
});

test("connections with no default: the notice shows and a ready connection's page offers Make default", async () => {
  orgList = [entry("openai")];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers");
  await view.findByText("No default AI. Choose one so Bots can start work.");
  await user.click(view.getByRole("link", { name: /OpenAI API key/ }));
  const make = await view.findByRole("button", { name: "Make default" });
  expect((make as HTMLButtonElement).disabled).toBe(false);
});

test("a stopped connection shows its sentence, and Make default is disabled", async () => {
  const sentence = "Your Google sign-in ended. Sign in again to use it.";
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("google", {
      login: "oauth",
      model: "gemini-3.8-flash",
      ready: false,
      problem: { code: "sign-in-ended", detail: sentence },
    }),
  ];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers");
  await view.findByText(sentence);
  await user.click(view.getByRole("link", { name: /Google sign-in/ }));
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(sentence);
  const make = view.getByRole("button", { name: "Make default" });
  expect((make as HTMLButtonElement).disabled).toBe(true);
});

test("Connect another AI is a page: it marks connected providers and posts connectAiConnection, not replace", async () => {
  orgList = [entry("anthropic", { isDefault: true })];
  const user = userEvent.setup({ document });
  const { view, router } = renderAt("/settings/providers");
  await user.click(
    await view.findByRole("link", { name: /Connect another AI/ }),
  );
  await view.findByRole("heading", { name: "Connect another AI" });
  expect(at(router)).toBe("/settings/providers/new");
  const anthropic = view.getByRole("button", { name: /Anthropic/ });
  expect(
    within(anthropic).getByRole("img", { name: "Connected" }),
  ).toBeDefined();
  expect(
    within(anthropic).getByText("Signed in with your Claude plan."),
  ).toBeDefined();
  // One connection: nothing to tell apart, so no Default.
  expect(within(anthropic).queryByText("Default")).toBeNull();
  await user.click(view.getByRole("button", { name: /^OpenAI/ }));
  await user.type(view.getByLabelText(/API key/), "sk-example");
  await user.click(view.getByRole("button", { name: /Connect/ }));
  await waitFor(() =>
    expect(writes()).toEqual([
      {
        method: "POST",
        path: `${ORG}/ai-connections`,
        body: { provider: "openai", login: "api-key", apiKey: "sk-example" },
      },
    ]),
  );
  /*
   * Then back to the list, still on Connect another AI, with OpenAI checked: never the new
   * connection's own page, which read as a detour after adding one.
   */
  const openai = await view.findByRole("button", { name: /^OpenAI/ });
  await waitFor(() =>
    expect(
      within(openai).getByRole("img", { name: "Connected" }),
    ).toBeDefined(),
  );
  expect(at(router)).toBe("/settings/providers/new");
  expect(within(openai).getByText("Uses your OpenAI API key.")).toBeDefined();
  expect(view.getByRole("status").textContent).toBe("OpenAI is connected.");
  // Nothing to cancel now: Done goes back to AI providers, where it is listed.
  expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
  await user.click(view.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(at(router)).toBe("/settings/providers"));
  expect(await view.findByRole("link", { name: /^OpenAI/ })).toBeDefined();
});

test("Connect another AI goes back to its list after each one, so a second connects from there", async () => {
  orgList = [];
  const user = userEvent.setup({ document });
  const { view, router } = renderAt("/settings/providers/new");
  await view.findByRole("heading", { name: "Connect an AI" });
  await user.click(await view.findByRole("button", { name: /^OpenAI/ }));
  await user.type(view.getByLabelText(/API key/), "sk-example");
  await user.click(view.getByRole("button", { name: /Connect/ }));
  // The first is connected: the page now connects another, with OpenAI checked in its list.
  await view.findByRole("heading", { name: "Connect another AI" });
  const openai = view.getByRole("button", { name: /^OpenAI/ });
  expect(within(openai).getByRole("img", { name: "Connected" })).toBeDefined();
  await user.click(view.getByRole("button", { name: /^Anthropic/ }));
  await user.type(view.getByLabelText(/API key/), "sk-ant-example");
  await user.click(view.getByRole("button", { name: /Connect/ }));
  const anthropic = await view.findByRole("button", { name: /^Anthropic/ });
  await waitFor(() =>
    expect(
      within(anthropic).getByRole("img", { name: "Connected" }),
    ).toBeDefined(),
  );
  expect(view.getAllByRole("img", { name: "Connected" })).toHaveLength(2);
  // The first stays the default, and says so now that there are two.
  expect(
    within(view.getByRole("button", { name: /^OpenAI/ })).getByText("Default"),
  ).toBeDefined();
  expect(view.getByRole("status").textContent).toBe("Anthropic is connected.");
  expect(at(router)).toBe("/settings/providers/new");
  expect(writes().map((call) => call.path)).toEqual([
    `${ORG}/ai-connections`,
    `${ORG}/ai-connections`,
  ]);
});

test("Connect another AI tags the default among several, and a stopped one offers Reconnect on its own way in", async () => {
  const sentence = "Google refuses this key. Connect it with another.";
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("google", {
      login: "endpoint",
      ready: false,
      problem: { code: "key-refused", detail: sentence },
    }),
  ];
  orgSignIns = ["anthropic", "google"];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/new");
  const anthropic = await view.findByRole("button", { name: /Anthropic/ });
  expect(within(anthropic).getByText("Default")).toBeDefined();
  expect(
    within(anthropic).getByRole("img", { name: "Connected" }),
  ).toBeDefined();
  const google = view.getByRole("button", { name: /Google/ });
  expect(within(google).getByText(sentence)).toBeDefined();
  expect(within(google).getByText("Reconnect")).toBeDefined();
  expect(within(google).queryByRole("img", { name: "Connected" })).toBeNull();
  expect(within(google).queryByText("Default")).toBeNull();
  await user.click(google);
  // Its own way in, a key, not the provider's first (its sign-in, which the server offers here).
  expect(await view.findByLabelText(/API key/)).toBeDefined();
  expect(
    view.queryByRole("button", { name: /Sign in with Google/ }),
  ).toBeNull();
});

test("a provider missing from signIns offers only its key", async () => {
  orgList = [entry("openai", { isDefault: true })];
  orgSignIns = [];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/new");
  await user.click(await view.findByRole("button", { name: /Anthropic/ }));
  expect(view.queryByText("Sign in with my plan")).toBeNull();
  expect(view.getByLabelText(/API key/)).toBeDefined();
});

test("the organization's list signs in through startAiSignIn when signIns names the provider", async () => {
  orgList = [entry("openai", { isDefault: true })];
  orgSignIns = ["anthropic"];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/new");
  await user.click(await view.findByRole("button", { name: /Anthropic/ }));
  await user.click(
    view.getByRole("button", { name: /Sign in with Anthropic/ }),
  );
  await waitFor(() =>
    expect(writes()[0]?.path).toBe(`${ORG}/ai-connection-sign-ins`),
  );
  expect(
    calls.some((call) => call.path.includes("/people/me/ai-connection/")),
  ).toBe(false);
});

test("every provider connected hides Connect another AI", async () => {
  orgList = (
    [
      "openai",
      "anthropic",
      "google",
      "xai",
      "unbiased",
      "trustedrouter",
      "openai-compatible",
    ] as const
  ).map((provider, index) =>
    entry(provider, {
      isDefault: index === 0,
      login:
        provider === "openai" || provider === "anthropic"
          ? "api-key"
          : "endpoint",
      endpointHost: provider === "openai-compatible" ? "llm.example.com" : null,
    }),
  );
  const { view } = renderAt("/settings/providers");
  await view.findByText("llm.example.com");
  expect(view.queryByText("Connect another AI")).toBeNull();
});

test("a person's own connection's page posts to their own connections", async () => {
  personal = PERSONAL;
  personalList = [entry("anthropic", { isDefault: true }), entry("openai")];
  orgList = [entry("openai", { isDefault: true })];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/openai?owner=personal");
  await user.click(await view.findByRole("button", { name: "Make default" }));
  await waitFor(() =>
    expect(writes()).toEqual([
      {
        method: "POST",
        path: `${ORG}/people/me/ai-connections/openai/make-default`,
      },
    ]),
  );
});

test("a stopped sign-in leads with Sign in again, a page that opens its provider ready to sign in", async () => {
  orgSignIns = ["google"];
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("google", {
      login: "oauth",
      model: "gemini-3.8-flash",
      ready: false,
      problem: { code: "sign-in-ended", detail: "Your Google sign-in ended." },
    }),
  ];
  const user = userEvent.setup({ document });
  const { view, router } = renderAt("/settings/providers/google");
  await user.click(await view.findByRole("link", { name: /Sign in again/ }));
  expect(
    await view.findByRole("heading", { name: "Reconnect Google sign-in" }),
  ).toBeDefined();
  expect(at(router)).toBe("/settings/providers/google/change");
  expect(
    view.getByRole("button", { name: "Sign in with Google" }),
  ).toBeDefined();
});

test("a stopped key leads with Replace key, a page that opens its provider's key field", async () => {
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("openai", {
      ready: false,
      problem: { code: "key-refused", detail: "OpenAI refused the key." },
    }),
  ];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/openai");
  await user.click(await view.findByRole("link", { name: /Replace key/ }));
  expect(
    await view.findByRole("heading", { name: "Reconnect OpenAI API key" }),
  ).toBeDefined();
  expect(view.getByLabelText(/API key/)).toBeDefined();
});

test("on OpenBot Cloud the organization's several connections are for whoever has none of their own", async () => {
  personal = PERSONAL;
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  const { view } = renderAt("/settings/providers");
  await view.findByRole("heading", { name: "Organization's AI" });
  // The reader may run on their own connections, never these: not "your Bots".
  expect(
    await view.findByText(
      /Anyone who hasn't connected their own can pick a model from any of these in a conversation\./,
    ),
  ).toBeDefined();
  expect(view.queryByText(/Your Bots can use any of these/)).toBeNull();
});

test("Replace key opens on the key even where the server also signs in to that provider", async () => {
  orgSignIns = ["anthropic", "openai"];
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("openai", {
      ready: false,
      problem: { code: "key-refused", detail: "OpenAI refused the key." },
    }),
  ];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/openai");
  await user.click(await view.findByRole("link", { name: /Replace key/ }));
  await view.findByRole("heading", { name: "Reconnect OpenAI API key" });
  // Its way in, not the first one offered: a key connection asks for the key.
  expect(
    view
      .getByRole("tab", { name: "Use an API key" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(view.getByLabelText(/API key/)).toBeDefined();
});

test("removing a person's last own connection says what happens next, and sends them to connect one when it is required", async () => {
  personal = PERSONAL;
  personalList = [entry("anthropic", { isDefault: true })];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/anthropic?owner=personal");
  expect(
    await view.findByText(
      "Remove it and Bots can't work for you until you connect another.",
    ),
  ).toBeDefined();
  // After the removal the server says the person has no AI, and one is required.
  personal = { ...PERSONAL, uses: "none" };
  await user.click(view.getByRole("button", { name: "Disconnect" }));
  await waitFor(() =>
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/onboarding?step=ai",
    ),
  );
});

test("removing a person's last own connection where the organization has an AI says Bots use the organization's", async () => {
  personal = {
    ...PERSONAL,
    organization: { ready: true, provider: "openai" },
  };
  personalList = [entry("anthropic", { isDefault: true })];
  const { view } = renderAt("/settings/providers/anthropic?owner=personal");
  expect(
    await view.findByText(
      "Remove it and Bots use your organization's AI for you.",
    ),
  ).toBeDefined();
});

test("disconnecting the organization's last connection on OpenBot Cloud says Bots work only for people with their own", async () => {
  personal = PERSONAL;
  orgList = [entry("anthropic", { isDefault: true })];
  const { view } = renderAt("/settings/providers/anthropic");
  expect(
    await view.findByText(
      "Disconnect it and Bots work only for people who connected their own AI.",
    ),
  ).toBeDefined();
});

test("disconnecting the default with exactly one other left removes it alone, and says which becomes the default", async () => {
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/anthropic");
  expect(
    await view.findByText(
      "Bots will use OpenAI API key when nobody picked a model.",
    ),
  ).toBeDefined();
  expect(view.queryByRole("radio")).toBeNull();
  await user.click(view.getByRole("button", { name: "Disconnect" }));
  // The server makes the one left the default; the app asks for nothing else.
  await waitFor(() =>
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE ${ORG}/ai-connections/anthropic`,
    ]),
  );
});

test("after a disconnect the page goes back to AI providers, not to the provider it just disconnected", async () => {
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  const user = userEvent.setup({ document });
  const { view, router } = renderAt("/settings/providers/openai");
  const disconnect = await view.findByRole("button", { name: "Disconnect" });
  // The list is read again before everything the removal changed is: the page loses its entry first.
  personalDelay = 300;
  await user.click(disconnect);
  await waitFor(() => expect(at(router)).toBe("/settings/providers"));
  expect(view.queryByText("OpenAI isn't connected.")).toBeNull();
});

test("disconnecting the default when none of the others can run says they stay, with no default", async () => {
  const stopped = {
    ready: false,
    problem: { code: "key-refused", detail: "The key was refused." },
  };
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("openai", stopped),
    entry("google", {
      login: "endpoint",
      model: "gemini-3.8-flash",
      ...stopped,
    }),
  ];
  const { view } = renderAt("/settings/providers/anthropic");
  expect(
    await view.findByText(
      "It's the default AI, and none of the others can run now. Disconnect it and there's no default until you fix one and make it the default.",
    ),
  ).toBeDefined();
  expect(view.queryByText(/until you connect another/)).toBeNull();
  expect(view.queryByRole("radio")).toBeNull();
});

test("Change on a connection that isn't the default changes that one: its provider, no other to pick", async () => {
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  const user = userEvent.setup({ document });
  const { view, router } = renderAt("/settings/providers/openai");
  await user.click(await view.findByRole("link", { name: /^Change/ }));
  await view.findAllByRole("heading", { name: "Change OpenAI API key" });
  expect(at(router)).toBe("/settings/providers/openai/change");
  // Open on its provider: no grid of others to choose from.
  expect(view.queryByRole("button", { name: /Anthropic/ })).toBeNull();
  await user.type(view.getByLabelText(/API key/), "sk-example");
  await user.click(view.getByRole("button", { name: /Connect/ }));
  await waitFor(() =>
    expect(writes()).toEqual([
      {
        method: "POST",
        path: `${ORG}/ai-connections`,
        body: { provider: "openai", login: "api-key", apiKey: "sk-example" },
      },
    ]),
  );
});

test("Change on a connection that isn't the default keeps to its provider: its tile is not a way to another", async () => {
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  const user = userEvent.setup({ document });
  const { view } = renderAt("/settings/providers/openai/change");
  await view.findAllByRole("heading", { name: "Change OpenAI API key" });
  const providers = view.getByRole("group", { name: "AI provider" });
  expect(within(providers).queryByText("Change")).toBeNull();
  await user.click(within(providers).getByText("OpenAI"));
  // Still on OpenAI: no grid of others to pick, which would add one instead of changing this one.
  expect(view.queryByRole("button", { name: /Google Gemini/ })).toBeNull();
  expect(view.getByLabelText(/API key/)).toBeDefined();
});

/** Change one connection with a new key, from its own page's Change. */
async function changeWithKey(path: string) {
  const { view, router } = renderAt(path);
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText(/API key/), "sk-example");
  await user.click(view.getByRole("button", { name: /Connect/ }));
  return { view, router };
}

test("after changing one, it says what the server answered: beside the default, even with no default", async () => {
  orgList = [entry("openai"), entry("anthropic", { login: "api-key" })];
  const { view, router } = await changeWithKey(
    "/settings/providers/anthropic/change",
  );
  expect(
    await view.findByText(/Pick one of its models in a conversation/),
  ).toBeDefined();
  // Changing one goes back to its own page, where the person started.
  expect(at(router)).toBe("/settings/providers/anthropic?connected=added");
});

test("after changing the provider that is the default, it says the next message runs on it", async () => {
  personal = PERSONAL;
  personalList = [
    entry("openai", { isDefault: true }),
    entry("anthropic", { login: "api-key" }),
  ];
  const { view, router } = await changeWithKey(
    "/settings/providers/openai/change?owner=personal",
  );
  expect(await view.findByText(/Your next message runs on it/)).toBeDefined();
  expect(at(router)).toBe(
    "/settings/providers/openai?owner=personal&connected=in-use",
  );
});
