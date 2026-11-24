import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import { Route as ChannelNewRoute } from "@/routes/_authed/_app/channel/new";
import { botGrantsPath, botGrantsResponse } from "./bot-grants-api";
import {
  CONVERSATIONS_PATH,
  conversationOf,
  problem,
  ROUTE_PATH,
} from "./conversations-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A NEW CONVERSATION FROM + WORKS LIKE HOME: TYPE, SEND, AND OPENBOT PICKS THE BOT.
 *
 * Reported in dogfooding: choosing a Bot every time + was pressed was a chore, and usually not
 * needed. + opened with To: empty, its menu open and the caret in it, and Send with nobody in To:
 * said "Choose a Bot first." and refused. Home already let a person just type, and OpenBot picked.
 *
 * Now nobody in To: means OpenBot picks, through home's own path: the message is routed
 * (`POST /conversations/route`), and the conversation starts with the Bot the server named, or with
 * the default Bot when routing could not run. To: still takes one Bot or several, and a link that
 * names a Bot still has it picked.
 *
 * Everything above `fetch` is real: the `/channel/new` route, its To: field and composer, the start
 * sequence in lib/channels/start.ts and the generated client. `fetch` answers as the server does.
 */

const NativeResponse = globalThis.Response;

function bot(id: string, name: string): AgentProfile {
  return {
    assignedToMe: false,
    runsOnOpenBotModel: false,
    keyFromOpenBot: false,
    avatarSeed: "seed",
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
    name,
    roleDescription: "Role",
    systemOwned: false,
    title: "Title",
    visibility: "private",
    id,
  };
}

const GENERAL = bot("general-assistant", "General Assistant");
const RESEARCH = bot("research-assistant", "Research Assistant");
const ROSTER = [GENERAL, RESEARCH];

/** What reached the server, in order. */
let routed: Record<string, unknown>[] = [];
let created: Record<string, unknown>[] = [];
/** How the server answers `POST /conversations/route`. */
let routeAnswer: () => Response;
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
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
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url.pathname === ROUTE_PATH && method === "POST") {
      routed.push(JSON.parse(String(init?.body)));
      return routeAnswer();
    }
    if (url.pathname === CONVERSATIONS_PATH && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { botIds: string[] };
      created.push(body);
      const first = ROSTER.find((entry) => entry.id === body.botIds[0]);
      return NativeResponse.json(
        {
          conversation: conversationOf({
            id: `${body.botIds[0]}-conversation`,
            name: first?.name ?? "Conversation",
            agentIds: body.botIds,
            threadId: `${body.botIds[0]}-thread`,
            active: true,
            lastMessageAt: null,
          }),
        },
        { status: 201 },
      );
    }
    for (const entry of ROSTER)
      if (url.pathname === botGrantsPath(entry.id))
        return botGrantsResponse({ tools: [], skills: [] });
    return problem(404, "Not here.");
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  routed = [];
  created = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

/** The server picks Research Assistant for the message, as its router would for a research ask. */
function routesTo(picked: AgentProfile) {
  return () =>
    NativeResponse.json({
      botId: picked.id,
      name: picked.name,
      reason: "It does research.",
      fallback: false,
      viaMention: false,
    });
}

/** The sidebar's + beside the page: a plain link to `/channel/new`. */
function PlusBesidePage() {
  return (
    <>
      <Link aria-label="New conversation" to="/channel/new">
        +
      </Link>
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({ component: PlusBesidePage });
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
const homeRoute = createRoute({
  path: "/",
  getParentRoute: () => appRoute,
  component: () => <p>Home</p>,
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
/** Where a started conversation opens. Its own screen is not under test here. */
const channelRoute = createRoute({
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
  component: () => <p>Conversation opened</p>,
});
const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    appRoute.addChildren([homeRoute, testChannelNewRoute, channelRoute]),
  ]),
]);

function renderApp(initialEntry = "/") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(agentKeys.list(false), ROSTER);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router });
}

async function messageBox(view: ReturnType<typeof renderApp>) {
  return view.findByRole("textbox", { name: "Message" });
}

async function send(view: ReturnType<typeof renderApp>, text: string) {
  const editor = await messageBox(view);
  const user = userEvent.setup({ document });
  await user.click(editor);
  await user.keyboard(text);
  await waitFor(() => expect(editor.textContent).toBe(text));
  await user.keyboard("{Enter}");
}

test("+ then type and send with nobody in To: starts the conversation with the Bot OpenBot picks", async () => {
  routeAnswer = routesTo(RESEARCH);
  const view = renderApp();
  await userEvent
    .setup({ document })
    .click(await view.findByLabelText("New conversation"));

  // The caret is in the message, To: is closed, and it says OpenBot picks.
  const editor = await messageBox(view);
  await waitFor(() => expect(document.activeElement).toBe(editor));
  const to = view.getByRole("combobox") as HTMLInputElement;
  expect(to.getAttribute("aria-expanded")).toBe("false");
  expect(to.placeholder).toBe("OpenBot picks the right Bot, or choose one…");

  await send(view, "Find three papers on tidal energy.");

  await waitFor(() =>
    expect(view.router.state.location.pathname).toBe(
      "/channel/research-assistant-conversation",
    ),
  );
  // Asked of the server's router, with nobody named, as home asks.
  expect(routed).toEqual([{ text: "Find three papers on tidal energy." }]);
  expect(created).toEqual([{ botIds: [RESEARCH.id] }]);
  expect(view.queryByText("Choose a Bot first.")).toBeNull();
});

test("with nobody in To: and the router down, the message goes to the default Bot, as on home", async () => {
  routeAnswer = () => problem(502, "Couldn't pick a Bot.");
  const view = renderApp("/channel/new");

  await send(view, "What's on my calendar today?");

  await waitFor(() => expect(created).toEqual([{ botIds: [GENERAL.id] }]));
  await waitFor(() =>
    expect(view.router.state.location.pathname).toBe(
      "/channel/general-assistant-conversation",
    ),
  );
});

test("a Bot picked in To: still gets the message, and nobody else is picked for it", async () => {
  routeAnswer = routesTo(RESEARCH);
  const view = renderApp("/channel/new");
  const user = userEvent.setup({ document });

  await user.type(await view.findByRole("combobox"), "General");
  fireEvent.click(
    await view.findByRole("option", { name: /General Assistant/ }),
  );
  await view.findByRole("button", { name: "Remove General Assistant" });
  await send(view, "Draft a reply to the landlord.");

  await waitFor(() => expect(created).toEqual([{ botIds: [GENERAL.id] }]));
  // Recorded as the person's own choice, never inferred.
  expect(routed).toEqual([
    { text: "Draft a reply to the landlord.", botId: GENERAL.id },
  ]);
});

test("a link that names a Bot still has it picked, and sends to it", async () => {
  routeAnswer = routesTo(GENERAL);
  const view = renderApp(`/channel/new?agent=${RESEARCH.id}`);

  await view.findByRole("button", { name: "Remove Research Assistant" });
  await send(view, "Summarise the attached report.");

  await waitFor(() => expect(created).toEqual([{ botIds: [RESEARCH.id] }]));
});
