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
import { ActiveBotProvider, useActiveBot } from "@/lib/copilot/active-bot";
import {
  CheckInOfferCard,
  drawsOffer,
} from "@/lib/copilot/check-in-offer-tool";
import { settleReactWork } from "./settle-react-work";

/**
 * The card a Bot draws to offer a check-in on one thing. Nothing runs until the person presses Turn
 * on, which creates it daily unless they picked more often; Not now leaves nothing behind.
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
  window.localStorage.clear();
});

const BRIEF = {
  subject: "Launch brief in Notion",
  link: "https://www.notion.so/launch-brief",
};

function drawn(
  options: {
    settings?: unknown[];
    allowed?: boolean;
    toolCallId?: string;
    /** Where the card is drawn: a conversation, unless a case says otherwise. */
    at?: string;
  } = {},
) {
  const posted: unknown[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/proactive/settings" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      return Response.json({ setting: { id: "set_new" } }, { status: 201 });
    }
    if (url === "/api/proactive/settings")
      return Response.json({
        settings: options.settings ?? [],
        allowed: options.allowed ?? true,
      });
    if (url === "/api/agents/assistant")
      return Response.json({
        agent: { id: "assistant", name: "Personal Assistant" },
      });
    return Response.json({});
  }) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Card() {
    useActiveBot("assistant");
    return (
      <CheckInOfferCard
        link={BRIEF.link}
        readWith="mcp__notion__fetch"
        subject={BRIEF.subject}
        toolCallId={options.toolCallId ?? "call_1"}
      />
    );
  }
  const root = createRootRoute({ component: Outlet });
  const channel = createRoute({
    getParentRoute: () => root,
    path: "/channel/$channelId",
    component: Card,
  });
  const elsewhere = createRoute({
    getParentRoute: () => root,
    path: "/bots/$agentId",
    component: Card,
  });
  const router = createRouter({
    routeTree: root.addChildren([channel, elsewhere]),
    history: createMemoryHistory({
      initialEntries: [options.at ?? "/channel/ch_1"],
    }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ActiveBotProvider>
        <RouterProvider router={router as never} />
      </ActiveBotProvider>
    </QueryClientProvider>,
  );
  return { view, posted };
}

test("asks about the one thing, and turns on a daily check-in only when pressed", async () => {
  const { view, posted } = drawn();
  expect(
    await view.findByText(`Keep an eye on ${BRIEF.subject}?`),
  ).toBeTruthy();
  expect(posted).toEqual([]);
  fireEvent.click(view.getByRole("button", { name: "Turn on" }));
  await waitFor(() =>
    expect(posted).toEqual([
      {
        agentId: "assistant",
        subject: BRIEF.subject,
        focus: "",
        sourceLink: BRIEF.link,
        intervalMinutes: 1440,
        // What it read with, so the server works out what the check-in reads.
        readWith: "mcp__notion__fetch",
      },
    ]),
  );
});

test("an older check-in that read every app is offered again on its page", async () => {
  const { view } = drawn({
    settings: [
      {
        id: "set_1",
        agentId: "assistant",
        channelId: null,
        focus: "",
        subject: "Brief",
        sourceLink: BRIEF.link,
        sourceKind: "apps",
        enabled: true,
        intervalMinutes: 1440,
      },
    ],
  });
  expect(await view.findByRole("button", { name: "Turn on" })).toBeTruthy();
});

// A check-in belongs to its Bot, so the card turns one on wherever it is drawn.
test("turns on outside a conversation too, and sends no conversation", async () => {
  const { view, posted } = drawn({ at: "/bots/assistant" });
  fireEvent.click(await view.findByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).not.toHaveProperty("channelId");
  expect(view.queryByText(/Open this in a conversation/)).toBeNull();
});

test("Not now leaves nothing running, and stays said after a reload", async () => {
  const first = drawn();
  fireEvent.click(await first.view.findByRole("button", { name: "Not now" }));
  expect(
    await first.view.findByText(/No check-in on Launch brief in Notion/),
  ).toBeTruthy();
  expect(first.posted).toEqual([]);
  cleanup();
  const again = drawn();
  expect(
    await again.view.findByText(/No check-in on Launch brief in Notion/),
  ).toBeTruthy();
});

test("says so where the Bot already watches that page", async () => {
  const { view } = drawn({
    settings: [
      {
        id: "set_1",
        agentId: "assistant",
        channelId: "ch_1",
        focus: "",
        subject: "Brief",
        sourceLink: BRIEF.link,
        enabled: true,
        intervalMinutes: 1440,
      },
    ],
  });
  expect(
    await view.findByText(/checks Launch brief in Notion once a day/),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Turn on" })).toBeNull();
});

test("offers nothing where check-ins are turned off for the person", async () => {
  const { view } = drawn({ allowed: false });
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.queryByText(/Keep an eye on/)).toBeNull();
});

// FOUND IN AN AUDIT: a card offered a check-in on a page the Bot had read in its browser; it never ran.
test("no card is drawn when the server said there is nothing to offer", () => {
  expect(
    drawsOffer(
      "Nothing to offer: A check-in can only read an app the person connected…",
    ),
  ).toBe(false);
  expect(drawsOffer("A card in front of the person offers…")).toBe(true);
  // An answer from before the tool said either still draws, as it always did.
  expect(drawsOffer(undefined)).toBe(true);
});
