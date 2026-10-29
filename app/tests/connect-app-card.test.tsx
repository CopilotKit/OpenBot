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
import { ConnectAppCard } from "@/components/channels/connect-app-card";
import { carryOnMessage } from "@/lib/copilot/carry-on";
import { ConversationProvider } from "@/lib/copilot/conversation";
import { settleReactWork } from "./settle-react-work";

/**
 * The card a Bot's refusal turns into when the app it needed is one this person can connect.
 *
 * Three things it must never do, each of which it did:
 *
 * - navigate THIS tab. The consent screen belongs to the vendor and the trip is a full page load,
 *   so the conversation being read would be replaced by it and the question would be behind them.
 * - say "connected" over a row whose credential has been withdrawn, which takes away the button
 *   that is the only way to get access back.
 * - press Connect for an app that takes a typed key and then do nothing at all, because the route
 *   answers a form rather than a page to visit and there was no url to open.
 *
 * THE HARNESS IS THIS REPOSITORY'S: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, queries off `render()`'s own return, and a `QueryClient` with `retry: false`. The
 * router is real but minimal — the card links to a connector's settings page, and a `Link` has to
 * resolve against a route tree that contains it.
 */

// Captured inside `beforeAll`: there is no `window` until the registrator has made one.
let originalOpen: typeof window.open;
beforeAll(() => {
  GlobalRegistrator.register();
  originalOpen = window.open;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  window.open = originalOpen;
});

type Row = { serverId: string; holder?: string; revoked?: boolean };

function mounted(
  options: {
    connections?: Row[];
    /**
     * What `POST /connect` answers: a page to visit, a form to fill in, or an account the vendor
     * already held, which the route records on the press and lists from then on.
     */
    answers?: "url" | "fields" | "failure" | "connected";
    /** False stands in for a browser that refused the tab, which answers null. */
    popupsAllowed?: boolean;
    /** Drawn inside a conversation, as the latest thing in it: what the card sends is kept here. */
    asked?: string[];
  } = {},
) {
  const { connections = [], answers = "url", popupsAllowed = true } = options;

  /** Where a claimed tab was pointed, which is the only evidence the vendor was reached. */
  const sentTo: string[] = [];
  let closed = 0;
  let claimed = 0;
  window.open = ((url?: string) => {
    claimed += 1;
    if (url) sentTo.push(url);
    if (!popupsAllowed) return null;
    const tab = {
      opener: {} as unknown,
      location: {
        replace: (next: string) => {
          sentTo.push(next);
        },
      },
      close: () => {
        closed += 1;
      },
    };
    return tab as unknown as Window;
  }) as typeof window.open;

  /** Whether the route has recorded the account, which is what the connections read lists. */
  let recorded = false;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/api/plugins/connections"))
      return json({
        connections: recorded
          ? [...connections, { serverId: "srv_notion", holder: "person" }]
          : connections,
        redirectUri: null,
      });
    if (url.includes("/connect") && init?.method === "POST") {
      if (answers === "failure")
        return json({ error: "That account could not be connected." }, 502);
      // What a key-entry app answers: a form to fill in, and no page to visit.
      if (answers === "fields")
        return json({ fields: [{ name: "api_key", type: "string" }] });
      // What the route answers once it has recorded an account the vendor already held.
      if (answers === "connected") {
        recorded = true;
        return json({ connected: true });
      }
      return json({ authorizationUrl: "https://notion.test/consent" });
    }
    return json({});
  }) as unknown as typeof fetch;

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // One card, one tool call, however often the route draws it.
  const toolCallId = `call_${Math.random().toString(36).slice(2)}`;
  const root = createRootRoute({ component: Outlet });
  const card = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => {
      const drawn = (
        <ConnectAppCard
          message="You have not connected your Notion account. Connect it and ask again."
          place={{ toolCallId, latest: true }}
          serverId="srv_notion"
          title="Notion"
        />
      );
      const { asked } = options;
      return asked ? (
        <ConversationProvider ask={(text) => asked.push(text)}>
          {drawn}
        </ConversationProvider>
      ) : (
        drawn
      );
    },
  });
  // The destination the card links to for an app connected with a typed key.
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([card, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return {
    view,
    sentTo,
    tabsClosed: () => closed,
    tabsClaimed: () => claimed,
  };
}

const press = (card: ReturnType<typeof mounted>) =>
  fireEvent.click(card.view.getByRole("button", { name: /^Connect$/ }));

test("asks for the app by name, in the words the Bot used", async () => {
  const card = mounted();

  await waitFor(() =>
    expect(card.view.getByText(/Connect Notion/)).toBeTruthy(),
  );
  expect(
    card.view.getByText(/You have not connected your Notion account/),
  ).toBeTruthy();
});

test("sends the person to the vendor in another tab, never in this one", async () => {
  const card = mounted();
  const before = window.location.href;
  await waitFor(() => card.view.getByRole("button", { name: /^Connect$/ }));

  press(card);

  await waitFor(() =>
    expect(card.sentTo).toContain("https://notion.test/consent"),
  );
  expect(window.location.href).toBe(before);
  expect(card.view.getByText(/Finish in the tab that opened/)).toBeTruthy();
});

test("claims the tab on the click itself, before the request that mints the url", async () => {
  /*
   * A browser only lets a page open a tab while a click is still recent — about five seconds in
   * Chrome. Opening after the request came back put that window at the mercy of how slow the
   * deployment was, and a blocked tab left the card telling somebody to finish in one that was
   * never there.
   */
  const card = mounted();
  await waitFor(() => card.view.getByRole("button", { name: /^Connect$/ }));

  press(card);

  // Claimed synchronously: the count has already moved before anything is awaited.
  expect(card.tabsClaimed()).toBe(1);
  await waitFor(() =>
    expect(card.sentTo).toContain("https://notion.test/consent"),
  );
});

test("offers the link when the browser blocked the tab anyway", async () => {
  const card = mounted({ popupsAllowed: false });
  await waitFor(() => card.view.getByRole("button", { name: /^Connect$/ }));

  press(card);

  const link = await waitFor(() =>
    card.view.getByRole("link", { name: /Open Notion's sign-in/ }),
  );
  expect(link.getAttribute("href")).toBe("https://notion.test/consent");
});

test("says where to type a key for an app that has no page to visit", async () => {
  const card = mounted({ answers: "fields" });
  await waitFor(() => card.view.getByRole("button", { name: /^Connect$/ }));

  press(card);

  const link = await waitFor(() =>
    card.view.getByRole("link", { name: /Enter it on Notion's page/ }),
  );
  expect(link.getAttribute("href")).toBe("/connections/srv_notion");
  // The blank tab claimed on the click is let go rather than left sitting on about:blank.
  expect(card.tabsClosed()).toBe(1);
});

test("says connected when the press records an account the vendor already held", async () => {
  /*
   * The vendor refused a second link because it already held this person's account, and the route
   * recorded that account on the press. Read as "no url", the card told the person to type a key
   * for an app that had just been connected through a sign-in.
   */
  const card = mounted({ answers: "connected" });
  await waitFor(() => card.view.getByRole("button", { name: /^Connect$/ }));

  press(card);

  await waitFor(() =>
    expect(card.view.getByText(/Notion is connected/)).toBeTruthy(),
  );
  expect(card.view.queryByText(/needs a key from you/)).toBeNull();
  // Nothing to visit: the claimed tab is let go without ever being pointed anywhere.
  expect(card.tabsClosed()).toBe(1);
  expect(card.sentTo).toEqual([]);
});

test("lets go of the claimed tab when connecting fails", async () => {
  const card = mounted({ answers: "failure" });
  await waitFor(() => card.view.getByRole("button", { name: /^Connect$/ }));

  press(card);

  await waitFor(() => expect(card.tabsClosed()).toBe(1));
  // The tab was claimed and let go without ever being pointed at the vendor.
  expect(card.sentTo).toEqual([]);
  expect(card.view.getByText(/could not be connected/)).toBeTruthy();
});

test("says so once the account is actually listed, rather than once they return", async () => {
  const card = mounted({
    connections: [{ serverId: "srv_notion", holder: "person" }],
  });

  await waitFor(() =>
    expect(card.view.getByText(/Notion is connected/)).toBeTruthy(),
  );
  // No button to press any more: the next step is to ask the Bot again.
  expect(card.view.queryByRole("button", { name: /^Connect$/ })).toBeNull();
});

test("does not read a withdrawn credential as a connected account", async () => {
  /*
   * The row outlives the secret. Drawn over the "your access was withdrawn" refusal, a card
   * reading the row alone said the app was connected and removed the only way back.
   */
  const card = mounted({
    connections: [{ serverId: "srv_notion", holder: "person", revoked: true }],
  });

  await waitFor(() =>
    expect(card.view.getByRole("button", { name: /^Connect$/ })).toBeTruthy(),
  );
  expect(card.view.queryByText(/Notion is connected/)).toBeNull();
});

test("does not read a Shared app's deployment account as this person's", async () => {
  const card = mounted({
    connections: [{ serverId: "srv_notion", holder: "deployment" }],
  });

  await waitFor(() =>
    expect(card.view.getByRole("button", { name: /^Connect$/ })).toBeTruthy(),
  );
  expect(card.view.queryByText(/Notion is connected/)).toBeNull();
});

test("once connected in front of the person, the conversation carries on by itself, once", async () => {
  const asked: string[] = [];
  const card = mounted({ answers: "connected", asked });
  await waitFor(() => card.view.getByRole("button", { name: /^Connect$/ }));

  press(card);

  await waitFor(() => expect(asked).toEqual([carryOnMessage("Notion")]));
  expect(card.view.getByText("Notion is connected.")).toBeTruthy();
  await settleReactWork();
  expect(asked).toHaveLength(1);
});
