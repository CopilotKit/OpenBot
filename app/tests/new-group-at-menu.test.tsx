import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type DeploymentCapabilities,
  deploymentKeys,
} from "@/lib/deployment/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { settleReactWork } from "./settle-react-work";

/**
 * `@` IN A NEW CONVERSATION OFFERS THE BOTS IN TO:, BEFORE ANYTHING HAS BEEN SENT.
 *
 * FOUND ON WINDOWS: a new conversation with two Bots in To:, nothing sent yet, and `@` in the
 * composer said "No Bots in this conversation". The person could not address one of them in their
 * first message; only once the group existed did `@` list its Bots. The Bots in To: are who the
 * conversation is with, so they are who `@` offers, and a first message addressed to one goes to
 * that Bot only, as every later message in the group does.
 *
 * Everything above `fetch` is real: the `/channel/new` route, its To: picker, its composer and the
 * start sequence. `fetch` records what left the browser.
 */

const NativeResponse = globalThis.Response;

function agent(
  overrides: Partial<AgentProfile> & { id: string; name: string },
): AgentProfile {
  return {
    avatarSeed: overrides.id,
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    mine: true,
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    ...overrides,
  };
}

const CLAUDE = agent({ id: "claude-agent-sdk", name: "Claude Agent SDK" });
const ASSISTANT = agent({ id: "picked-harness", name: "Personal Assistant" });

/** Every write that left the browser, as `METHOD /path body`. */
let sent: { method: string; path: string; body: unknown }[] = [];
let originalFetch: typeof fetch;
let originalRect: typeof Range.prototype.getBoundingClientRect;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  /*
   * The `@` menu opens at the caret: prompt-area measures the caret's range and draws no menu for a
   * range with no box. happy-dom lays nothing out, so every range measures empty; a browser's caret
   * is a line tall. This is that line, and nothing else about layout is assumed.
   */
  originalRect = Range.prototype.getBoundingClientRect;
  const caret = { x: 8, y: 8, top: 8, left: 8, width: 1, height: 16 };
  Range.prototype.getBoundingClientRect = () =>
    ({ ...caret, right: 9, bottom: 24, toJSON: () => caret }) as DOMRect;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "GET")
      sent.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    if (url.pathname === "/api/groups" && method === "POST")
      return NativeResponse.json(
        {
          channel: {
            id: "group-1",
            name: "Claude Agent SDK, Personal Assistant",
            agentIds: [CLAUDE.id, ASSISTANT.id],
            threadId: "group-thread",
            active: true,
            lastMessageAt: null,
          },
        },
        { status: 201 },
      );
    if (url.pathname === "/api/groups/group-1" && method === "POST")
      return new NativeResponse(null, { status: 202 });
    if (url.pathname === "/api/channels" && method === "POST")
      return NativeResponse.json(
        {
          channel: {
            id: "channel-1",
            name: "Claude Agent SDK",
            agentIds: [CLAUDE.id],
            threadId: "channel-thread",
            active: true,
            lastMessageAt: null,
          },
        },
        { status: 201 },
      );
    return NativeResponse.json({ error: "Not here." }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  sent = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  Range.prototype.getBoundingClientRect = originalRect;
  GlobalRegistrator.unregister();
});

const rootRoute = createRootRoute({ component: Outlet });
const authedRoute = createRoute({
  id: "/_authed",
  getParentRoute: () => rootRoute,
  component: Outlet,
});
const appRoute = createRoute({
  id: "/_app",
  getParentRoute: () => authedRoute,
  component: Outlet,
});
type TestFileRouteWiring = Parameters<typeof ChannelNewRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
};
const testChannelNewRoute = ChannelNewRoute.update({
  id: "/channel/new",
  path: "/channel/new",
  getParentRoute: () => appRoute,
} as TestFileRouteWiring);
/** Where a started conversation opens. Only that it was opened matters here. */
const groupRoute = createRoute({
  path: "/group/$channelId",
  getParentRoute: () => appRoute,
  component: () => <p>The group</p>,
});
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: () => <p>The conversation</p>,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([testChannelNewRoute, groupRoute, channelRoute]),
  ]),
]);

/** The personal edition. A new conversation starts with nobody in To:, so each test picks its Bots. */
function renderNewConversation(agents: AgentProfile[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), agents);
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  } satisfies DeploymentCapabilities);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/channel/new"] }),
  });
  return Object.assign(
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    { router },
  );
}

type View = ReturnType<typeof renderNewConversation>;

/** Add a Bot to To:, as a person does: type its name in the field and pick it. */
async function addToTo(view: View, name: string) {
  await userEvent
    .setup({ document })
    .type(await view.findByRole("combobox", { hidden: true }), name);
  fireEvent.click(
    await view.findByRole("option", { hidden: true, name: new RegExp(name) }),
  );
  await view.findByRole("button", { hidden: true, name: `Remove ${name}` });
}

/** Type `@` in the composer and read the names the menu offers. */
async function namesOfferedByAt(view: View): Promise<string[]> {
  const editor = await view.findByRole("textbox", {
    hidden: true,
    name: "Message",
  });
  const user = userEvent.setup({ document });
  await user.click(editor);
  await user.keyboard("@");
  const menu = await view.findByRole("listbox", {
    hidden: true,
    name: "@ suggestions",
  });
  return [...menu.querySelectorAll('[role="option"]')].map(
    (option) => option.textContent ?? "",
  );
}

test("@ in a new conversation with two Bots in To: offers both, and the first message goes to the one picked", async () => {
  const view = renderNewConversation([CLAUDE, ASSISTANT]);
  await addToTo(view, "Personal Assistant");
  await addToTo(view, "Claude Agent SDK");

  const offered = await namesOfferedByAt(view);
  expect(offered).toEqual([
    expect.stringContaining("Personal Assistant"),
    expect.stringContaining("Claude Agent SDK"),
  ]);
  expect(offered.join()).not.toContain("No Bots in this conversation");

  const user = userEvent.setup({ document });
  await user.keyboard("Claude");
  await user.click(
    await view.findByRole("option", {
      hidden: true,
      name: /Claude Agent SDK/,
    }),
  );
  await user.keyboard("hello{Enter}");

  // The group is made with both Bots, and its first message is addressed to the one picked.
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[0]).toEqual({
    method: "POST",
    path: "/api/groups",
    body: { agentIds: [ASSISTANT.id, CLAUDE.id] },
  });
  expect(sent[1]?.path).toBe("/api/groups/group-1");
  expect(sent[1]?.body).toMatchObject({
    agentId: CLAUDE.id,
    text: "@Claude Agent SDK hello",
  });
  await waitFor(() =>
    expect(view.router.state.location.pathname).toBe("/group/group-1"),
  );
});

test("a first message to a new group with no @ still goes to every Bot", async () => {
  const view = renderNewConversation([CLAUDE, ASSISTANT]);
  await addToTo(view, "Personal Assistant");
  await addToTo(view, "Claude Agent SDK");
  const editor = await view.findByRole("textbox", {
    hidden: true,
    name: "Message",
  });
  const user = userEvent.setup({ document });
  await user.click(editor);
  await user.keyboard("hello both{Enter}");

  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]?.body).toMatchObject({ agentId: null, text: "hello both" });
});

test("a Bot taken out of To: is no longer offered by @", async () => {
  const view = renderNewConversation([CLAUDE, ASSISTANT]);
  await addToTo(view, "Personal Assistant");
  await addToTo(view, "Claude Agent SDK");
  fireEvent.click(
    view.getByRole("button", {
      hidden: true,
      name: "Remove Personal Assistant",
    }),
  );
  await waitFor(() =>
    expect(
      view.queryByRole("button", {
        hidden: true,
        name: "Remove Personal Assistant",
      }),
    ).toBeNull(),
  );

  const offered = await namesOfferedByAt(view);
  expect(offered).toEqual([expect.stringContaining("Claude Agent SDK")]);
});

test("a new conversation with its one Bot picked offers that Bot to @, and sends to it alone", async () => {
  const view = renderNewConversation([CLAUDE]);
  await addToTo(view, "Claude Agent SDK");

  const offered = await namesOfferedByAt(view);
  expect(offered).toEqual([expect.stringContaining("Claude Agent SDK")]);

  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("option", {
      hidden: true,
      name: /Claude Agent SDK/,
    }),
  );
  await user.keyboard("hello{Enter}");

  await waitFor(() =>
    expect(sent).toContainEqual({
      method: "POST",
      path: "/api/channels",
      body: { agentIds: [CLAUDE.id] },
    }),
  );
  expect(sent.some((write) => write.path.startsWith("/api/groups"))).toBe(
    false,
  );
});
