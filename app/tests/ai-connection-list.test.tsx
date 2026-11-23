/**
 * Settings: several AI connections at once (plans/multiple-ai-connections-spec.md, step 2).
 *
 * The AI model section (the organization's) and Your AI (a person's own, on OpenBot Cloud) list one
 * row per connection, tag the default once there are two, add another with the shared chooser, make
 * one the default, and disconnect one. Against a server older than the list (404) they draw the one
 * row they drew before.
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
const { AiModelSection } = await import("@/components/settings/ai-connection");
const { YourAiSection } = await import("@/components/settings/your-ai");

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
  if (path === `${ORG}/people/me/ai-connection` && method === "GET")
    return personal
      ? json(200, GetPersonalAiConnectionResponse.parse(personal))
      : notFound();
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
      return json(201, ConnectAiConnectionResponse.parse(added));
    }
    const makeDefault = new RegExp(`^${base}/([^/]+)/make-default$`).exec(path);
    if (makeDefault && method === "POST" && list) {
      const id = decodeURIComponent(makeDefault[1] ?? "");
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
  global.fetch = Object.assign(fakeFetch, {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch;
  window.open = (() => null) as typeof window.open;
  window.history.replaceState(null, "", "/settings");
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

function renderOrganization() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AiModelSection />
    </QueryClientProvider>,
  );
}

function renderPersonal() {
  return render(
    <QueryClientProvider client={queryClient}>
      <YourAiSection />
    </QueryClientProvider>,
  );
}

const writes = () => calls.filter((call) => call.method !== "GET");

test("404 for the list draws today's single row, for the organization", async () => {
  const view = renderOrganization();
  await view.findByText("Anthropic");
  expect(view.queryByText("Connect another AI")).toBeNull();
  expect(calls.some((call) => call.path === `${ORG}/ai-connections`)).toBe(
    true,
  );
});

test("404 for the list draws today's single row, for a person's own AI", async () => {
  personal = PERSONAL;
  const view = renderPersonal();
  await view.findByText("Anthropic");
  expect(view.queryByText("Connect another AI")).toBeNull();
});

test("one connection: one row, no Default tag, and Connect another AI", async () => {
  orgList = [entry("anthropic", { isDefault: true })];
  const view = renderOrganization();
  await view.findByText("Claude plan");
  expect(view.getByText("Connect another AI")).toBeDefined();
  expect(view.queryByText("Default")).toBeNull();
});

test("two connections: the default is tagged and Make default on the other sends makeAiConnectionDefault", async () => {
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("openai", { connectedAt: "2026-11-21T09:00:00.000Z" }),
  ];
  const user = userEvent.setup({ document });
  const view = renderOrganization();
  const claude = await view.findByRole("button", { name: /Claude plan/ });
  expect(within(claude).getByText("Default")).toBeDefined();
  await user.click(view.getByRole("button", { name: /OpenAI API key/ }));
  const dialog = await view.findByRole("dialog");
  await user.click(
    within(dialog).getByRole("button", { name: "Make default" }),
  );
  await waitFor(() =>
    expect(writes()).toEqual([
      { method: "POST", path: `${ORG}/ai-connections/openai/make-default` },
    ]),
  );
});

test("disconnecting the default asks which takes over, and sends make-default before the remove", async () => {
  orgList = [
    entry("anthropic", { isDefault: true }),
    entry("openai"),
    entry("google", { login: "endpoint", model: "gemini-3.8-flash" }),
  ];
  const user = userEvent.setup({ document });
  const view = renderOrganization();
  await user.click(await view.findByRole("button", { name: /Claude plan/ }));
  const dialog = await view.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  const google = await within(dialog).findByRole("radio", {
    name: /Google Gemini API key/,
  });
  await user.click(google);
  await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  await waitFor(() =>
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${ORG}/ai-connections/google/make-default`,
      `DELETE ${ORG}/ai-connections/anthropic`,
    ]),
  );
});

test("connections with no default: the notice shows and a ready row offers Make default", async () => {
  orgList = [entry("openai")];
  const user = userEvent.setup({ document });
  const view = renderOrganization();
  await view.findByText("No default AI. Choose one so Bots can start work.");
  await user.click(view.getByRole("button", { name: /OpenAI API key/ }));
  const dialog = await view.findByRole("dialog");
  const make = within(dialog).getByRole("button", { name: "Make default" });
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
  const view = renderOrganization();
  await view.findByText(sentence);
  await user.click(view.getByRole("button", { name: /Google sign-in/ }));
  const dialog = await view.findByRole("dialog");
  const make = within(dialog).getByRole("button", { name: "Make default" });
  expect((make as HTMLButtonElement).disabled).toBe(true);
});

test("Connect another AI marks connected providers and posts connectAiConnection, not replace", async () => {
  orgList = [entry("anthropic", { isDefault: true })];
  const user = userEvent.setup({ document });
  const view = renderOrganization();
  await user.click(
    await view.findByRole("button", { name: /Connect another AI/ }),
  );
  const dialog = await view.findByRole("dialog");
  const anthropic = within(dialog).getByRole("button", { name: /Anthropic/ });
  expect(within(anthropic).getByText("Connected")).toBeDefined();
  await user.click(within(dialog).getByRole("button", { name: /^OpenAI/ }));
  await user.type(within(dialog).getByLabelText(/API key/), "sk-example");
  await user.click(within(dialog).getByRole("button", { name: /Connect/ }));
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

test("a provider missing from signIns offers only its key", async () => {
  orgList = [entry("openai", { isDefault: true })];
  orgSignIns = [];
  const user = userEvent.setup({ document });
  const view = renderOrganization();
  await user.click(
    await view.findByRole("button", { name: /Connect another AI/ }),
  );
  const dialog = await view.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: /Anthropic/ }));
  expect(within(dialog).queryByText("Sign in with my plan")).toBeNull();
  expect(within(dialog).getByLabelText(/API key/)).toBeDefined();
});

test("the organization's list signs in through startAiSignIn when signIns names the provider", async () => {
  orgList = [entry("openai", { isDefault: true })];
  orgSignIns = ["anthropic"];
  const user = userEvent.setup({ document });
  const view = renderOrganization();
  await user.click(
    await view.findByRole("button", { name: /Connect another AI/ }),
  );
  const dialog = await view.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: /Anthropic/ }));
  await user.click(
    within(dialog).getByRole("button", { name: /Sign in with Anthropic/ }),
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
  const view = renderOrganization();
  await view.findByText("llm.example.com");
  expect(view.queryByText("Connect another AI")).toBeNull();
});

test("a person's own list posts to their own connections", async () => {
  personal = PERSONAL;
  personalList = [entry("anthropic", { isDefault: true }), entry("openai")];
  const user = userEvent.setup({ document });
  const view = renderPersonal();
  await user.click(await view.findByRole("button", { name: /OpenAI API key/ }));
  const dialog = await view.findByRole("dialog");
  await user.click(
    within(dialog).getByRole("button", { name: "Make default" }),
  );
  await waitFor(() =>
    expect(writes()).toEqual([
      {
        method: "POST",
        path: `${ORG}/people/me/ai-connections/openai/make-default`,
      },
    ]),
  );
});

test("the address's connection opens that row's dialog", async () => {
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  window.history.replaceState(null, "", "/settings?connection=openai");
  const view = renderOrganization();
  const dialog = await view.findByRole("dialog");
  expect(within(dialog).getByText(/OpenAI API key/)).toBeDefined();
});

test("a connection the address names for a person's own AI opens only in Your AI, not the organization's list", async () => {
  orgList = [entry("anthropic", { isDefault: true }), entry("openai")];
  personal = PERSONAL;
  personalList = [entry("anthropic", { isDefault: true })];
  window.history.replaceState(
    null,
    "",
    "/settings?connection=anthropic&owner=personal",
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <YourAiSection />
      <AiModelSection organizationWide />
    </QueryClientProvider>,
  );
  await view.findByRole("dialog", { hidden: true });
  await view.findByText("Organization's AI");
  // A modal dialog hides the page under it from role queries: count the hidden ones too.
  await settleReactWork();
  expect(view.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
});

async function connectWithKey(
  view: ReturnType<typeof renderOrganization>,
  provider: RegExp,
) {
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("button", { name: /Connect another AI/ }),
  );
  const dialog = await view.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: provider }));
  await user.type(within(dialog).getByLabelText(/API key/), "sk-example");
  await user.click(within(dialog).getByRole("button", { name: /Connect/ }));
  return dialog;
}

test("after connecting, it says what the server answered: beside the default, even with no default", async () => {
  orgList = [entry("openai")];
  const view = renderOrganization();
  const dialog = await connectWithKey(view, /Anthropic/);
  expect(
    await within(dialog).findByText(/Pick one of its models in a conversation/),
  ).toBeDefined();
});

test("after connecting the provider that is the default again, it says the next message runs on it", async () => {
  orgList = [
    entry("openai", { isDefault: true }),
    entry("anthropic", { login: "api-key" }),
  ];
  const view = renderOrganization();
  const dialog = await connectWithKey(view, /^OpenAI/);
  expect(
    await within(dialog).findByText(/Your next message runs on it/),
  ).toBeDefined();
});
