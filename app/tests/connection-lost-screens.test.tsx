/**
 * While the connection line shows, the screens under it wait for OpenBot instead of each saying in
 * red that its own read failed, and when OpenBot answers again they fill in by themselves.
 *
 * Inside OpenBot Desktop connected to an OpenBot that runs somewhere else, every request goes to the
 * desktop app's relay, which answers the page itself when that OpenBot does not: a 502, text/plain,
 * "OpenBot could not be reached." (desktop/src-tauri/src/connected/relay.rs). Seen on a real Windows
 * computer: the line named the cause, and under it every section stacked its own "Couldn't load ..."
 * notice; and once OpenBot answered, those notices stayed until the person went elsewhere and back.
 *
 * The desktop app stands in at `window.__TAURI_INTERNALS__`, answering `connection` as its plugin
 * does. The app's own query client, the line, the Bots roster and the client are the real ones.
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
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { BotRoster } from "@/components/bots/bot-roster";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  askWhetherOpenBotAnswers,
  deploymentCapabilitiesQueryOptions,
} from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { approvalInboxResponse } from "./approvals-api";
import { answerBotAttention, answerBotsList } from "./bots-api";
import { CONVERSATIONS_PATH, TASKS_PATH } from "./conversations-api";
import { CHECK_IN_ITEMS_PATH, pathOf } from "./schedules-api";
import { settleReactWork } from "./settle-react-work";

let openbot: "answers" | "unreachable";
const originalFetch = globalThis.fetch;

function relayUnreachable(): Response {
  return new Response("OpenBot could not be reached.", {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function bot(overrides: Partial<AgentProfile> & { id: string }): AgentProfile {
  return {
    assignedToMe: false,
    runsOnOpenBotModel: false,
    keyFromOpenBot: false,
    name: overrides.id,
    title: "Title",
    roleDescription: "Role",
    avatarSeed: "seed",
    visibility: "private",
    endpoint: null,
    builtIn: true,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    systemOwned: false,
    canManage: true,
    mine: true,
    ...overrides,
  };
}

/** The OpenBot at the typed address, when it answers: one Bot, nothing waiting. */
function answer(input: RequestInfo | URL, init?: RequestInit): Response {
  const url = String(input);
  const waiting = answerBotAttention(input, init, { bots: [] });
  if (waiting) return waiting;
  if (pathOf(url) === CHECK_IN_ITEMS_PATH)
    return Response.json({ checkInItems: [], nextCursor: null });
  if (url.split("?")[0] === TASKS_PATH)
    return Response.json({ tasks: [], nextCursor: null });
  if (url.split("?")[0] === CONVERSATIONS_PATH)
    return Response.json({ conversations: [], nextCursor: null });
  if (url.endsWith("/deployment")) return Response.json({ edition: "team" });
  return (
    answerBotsList(input, init, {
      visible: [bot({ id: "mine", name: "Mine" })],
    }) ??
    approvalInboxResponse(input) ??
    Response.json({})
  );
}

function connectedDesktop() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      if (command === "plugin:openbot-desktop|connection")
        return { mode: "connected", address: "https://openbot.example.com" };
      throw `command ${command} not found`;
    },
    transformCallback: () => 0,
  };
}

/** A read of a screen whose query is never retried, as a refusal that is the answer is not. */
function Edition() {
  const deployment = useQuery({
    ...deploymentCapabilitiesQueryOptions(),
    retry: false,
  });
  if (deployment.error)
    return <p role="alert">Couldn't load what OpenBot can do.</p>;
  return deployment.data ? <p>Edition: {deployment.data.edition}</p> : null;
}

beforeAll(() => GlobalRegistrator.register({ url: "http://127.0.0.1:53112/" }));
beforeEach(() => {
  openbot = "answers";
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      openbot === "answers" ? answer(input, init) : relayUnreachable(),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  // Leave OpenBot answering, and nothing held, for the files after this one. A plain request, not
  // a read: reads wait while the connection is lost.
  openbot = "answers";
  await askWhetherOpenBotAnswers();
  queryClient.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function draw() {
  const rootRoute = createRootRoute();
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <>
          <ConnectionBanner />
          <Edition />
          <BotRoster />
        </>
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/bots/$agentId",
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

/** OpenBot stops answering, and the line has had time to say so and every read time to fail. */
async function openbotGoesAway() {
  connectedDesktop();
  openbot = "unreachable";
  const view = draw();
  await view.findByRole(
    "complementary",
    { name: "Connection" },
    { timeout: 5_000 },
  );
  // Long past the one retry a read gets, and the second it waits before it.
  await act(() => new Promise((resolve) => setTimeout(resolve, 2_500)));
  return view;
}

test("while the line shows, no screen says its own read failed", async () => {
  const view = await openbotGoesAway();
  expect(
    view.queryAllByRole("alert").map((alert) => alert.textContent),
  ).toEqual([]);
  expect(
    view.queryByText("Couldn't load your Bots", { exact: false }),
  ).toBeNull();
}, 15_000);

test("when OpenBot answers again, every screen fills in by itself", async () => {
  const view = await openbotGoesAway();

  openbot = "answers";
  // The line asks OpenBot itself, and clears; nobody clicks anything.
  await waitFor(
    () =>
      expect(
        view.queryByRole("complementary", { name: "Connection" }),
      ).toBeNull(),
    { timeout: 8_000 },
  );
  expect(await view.findByText("Mine", {}, { timeout: 5_000 })).toBeTruthy();
  expect(
    await view.findByText("Edition: team", {}, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(view.queryAllByRole("alert")).toEqual([]);
}, 25_000);

test("a browser with no desktop app around it still says a read failed, for there is no line", async () => {
  openbot = "unreachable";
  const view = draw();
  expect(
    await view.findByText(
      "Couldn't load what OpenBot can do.",
      {},
      { timeout: 5_000 },
    ),
  ).toBeTruthy();
  expect(view.queryByRole("complementary", { name: "Connection" })).toBeNull();
}, 15_000);
