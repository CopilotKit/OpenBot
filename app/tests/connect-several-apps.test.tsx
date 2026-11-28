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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useCallback, useState } from "react";
import { AppAccessCard } from "@/components/channels/app-access-card";
import type { AppAccess } from "@/lib/app-access/queries";
import { carryOnMessage } from "@/lib/copilot/carry-on";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { appAccess } from "./app-access-fixture";
import { botAppPath, botAppResponse } from "./bot-grants-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A BOT THAT NEEDS SEVERAL APPS FOR ONE TASK draws a card for each, in the one reply. Reported in
 * dogfooding: four cards (Notion, Slack, Fireflies and a custom MCP app), and connecting the first
 * sent "Notion is ready now" on its own. That message started the Bot's next turn, so the other three
 * cards were no longer the latest thing in the conversation, and connecting them told the Bot
 * nothing: the person had to stop the Bot and say the others were connected.
 *
 * The cards of one reply carry the task on together: once, when every one of them is ready, in one
 * message naming them all. A card ready while others still wait offers Continue, for a person who
 * means to go on without the rest.
 *
 * The harness moves the conversation on the way the transcript does: once anything is asked, no card
 * drawn before it is the latest thing any more.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const BOT = "research";

const APPS: AppAccess[] = [
  appAccess({ key: "srv_notion", displayName: "Notion" }),
  appAccess({ key: "srv_slack", displayName: "Slack" }),
  appAccess({ key: "srv_fireflies", displayName: "Fireflies" }),
  // A custom MCP app, connected with a key typed on its page rather than a consent screen.
  appAccess({
    key: "mcp_granola",
    displayName: "Granola",
    source: "address",
    connect: "key",
  }),
];

/** Each app's state as the server reads it now; a test connects one by setting it ready. */
function serving(state: Map<string, AppAccess["state"]>) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const app of APPS)
      if (url.includes(botAppPath(BOT, app.key)))
        return botAppResponse({
          ...app,
          state: state.get(app.key) ?? "not_connected",
        });
    if (url.includes("/api/plugins/connections"))
      return Response.json({ connections: [], redirectUri: null });
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** The transcript's gate: every card is the latest thing until something is asked after it. */
function Conversation({
  asked,
  children,
}: {
  asked: string[];
  children: (latest: boolean) => ReactNode;
}) {
  const [movedOn, setMovedOn] = useState(false);
  const ask = useCallback(
    (text: string) => {
      asked.push(text);
      setMovedOn(true);
    },
    [asked],
  );
  return (
    <ConversationProvider ask={ask}>{children(!movedOn)}</ConversationProvider>
  );
}

/** The Bot's reply with a card per app; drawn again with the same `reply`, it is the same cards. */
function mountReply(reply = Math.random().toString(36).slice(2)) {
  const asked: string[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <Conversation asked={asked}>
        {(latest) =>
          APPS.map((app) => (
            <AppAccessCard
              key={app.key}
              place={{ toolCallId: `${reply}_${app.key}`, latest }}
              prompt={{
                serverId: app.key,
                title: app.displayName,
                message: `You have not connected your ${app.displayName} account.`,
                agentId: BOT,
              }}
            />
          ))
        }
      </Conversation>
    ),
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { asked, client, reply });
}

const cardOf = (view: ReturnType<typeof mountReply>, key: string) =>
  view.container.querySelector(`[data-app-access="${key}"]`) as HTMLElement;

async function allDrawn(view: ReturnType<typeof mountReply>, state: string) {
  await waitFor(() => {
    for (const app of APPS)
      expect(cardOf(view, app.key)?.getAttribute("data-state")).toBe(state);
  });
}

/** Connect one app, as finishing its sign-in in another tab does, and let the cards read again. */
async function connect(
  view: ReturnType<typeof mountReply>,
  state: Map<string, AppAccess["state"]>,
  key: string,
) {
  state.set(key, "ready");
  await act(() => view.client.invalidateQueries());
  await waitFor(() =>
    expect(cardOf(view, key).getAttribute("data-state")).toBe("ready"),
  );
  await settleReactWork();
}

test("connecting every card of one reply tells the Bot about all of them, once", async () => {
  const state = new Map<string, AppAccess["state"]>();
  serving(state);
  const view = mountReply();
  await allDrawn(view, "not_connected");

  for (const app of APPS.slice(0, -1)) {
    await connect(view, state, app.key);
    // Others are still waiting: nothing is sent yet, so the Bot is not woken with part of the answer.
    expect(view.asked).toEqual([]);
  }
  await connect(view, state, "mcp_granola");

  await waitFor(() =>
    expect(view.asked).toEqual([
      carryOnMessage("Notion", "Slack", "Fireflies", "Granola"),
    ]),
  );
  expect(view.asked[0]).toBe(
    "Notion, Slack, Fireflies and Granola are ready now. Please carry on.",
  );
  await settleReactWork();
  expect(view.asked).toHaveLength(1);
  // Every card says it is ready, and none asks the person to tell the Bot themselves.
  for (const app of APPS)
    expect(cardOf(view, app.key).textContent).toContain(
      `${app.displayName} is ready now.`,
    );
  expect(view.container.textContent).not.toContain("Ask again");
  expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
});

test("a card ready while others wait offers Continue, which carries on with what is ready", async () => {
  const state = new Map<string, AppAccess["state"]>();
  serving(state);
  const view = mountReply();
  await allDrawn(view, "not_connected");

  await connect(view, state, "srv_notion");
  await connect(view, state, "srv_slack");
  expect(view.asked).toEqual([]);

  // One Continue for the reply, under the last card that is ready.
  const offered = await view.findAllByRole("button", { name: "Continue" });
  expect(offered).toHaveLength(1);
  expect(cardOf(view, "srv_slack").contains(offered[0] ?? null)).toBe(true);
  // The Bot will be told, so neither ready card tells the person to ask again themselves.
  expect(cardOf(view, "srv_notion").textContent).toContain(
    "Notion is ready now.",
  );
  expect(view.container.textContent).not.toContain("Ask again");

  fireEvent.click(offered[0] as HTMLElement);
  expect(view.asked).toEqual([carryOnMessage("Notion", "Slack")]);
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Continue" })).toBeNull(),
  );
  await settleReactWork();
  expect(view.asked).toHaveLength(1);
});

test("an app whose key is typed on its own page, away from the conversation, still counts", async () => {
  /*
   * Connect on a key app's card goes to the app's page in this tab, where the key is typed, so the
   * conversation and its cards are drawn again from nothing when the person comes back. Coming back
   * to every app ready, the task carries on by itself, naming them all.
   */
  const state = new Map<string, AppAccess["state"]>();
  serving(state);
  const first = mountReply();
  await allDrawn(first, "not_connected");
  for (const key of ["srv_notion", "srv_slack", "srv_fireflies"])
    await connect(first, state, key);
  expect(first.asked).toEqual([]);

  // Off to Granola's page: the conversation is gone while its key is typed.
  cleanup();
  state.set("mcp_granola", "ready");

  const back = mountReply(first.reply);
  await waitFor(() =>
    expect(back.asked).toEqual([
      carryOnMessage("Notion", "Slack", "Fireflies", "Granola"),
    ]),
  );
  await settleReactWork();
  expect(back.asked).toHaveLength(1);
  expect(back.queryByRole("button", { name: "Continue" })).toBeNull();
});
