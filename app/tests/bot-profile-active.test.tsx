import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { BotProfile } from "@/components/bot-profile/profile";
import type { AgentProfile } from "@/lib/agents/queries";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  botOperationPath,
  lifecycleOf,
  lifecycleResponse,
  pauseResponse,
  type SentRequest,
  sentRequest,
} from "./bots-api";
import { settleReactWork } from "./settle-react-work";

/**
 * The Bot page's pause control reads the way its switch sits: titled "Active" and on while the Bot
 * runs, off once it is paused. Titled "Paused", it showed the word "Paused" beside an off switch
 * for a Bot that was running.
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

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
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
};

function serving(paused: boolean, writes: SentRequest[] = []) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const sent = sentRequest(input, init);
    if (sent.path === botOperationPath("expenses", "pause")) {
      writes.push(sent);
      return pauseResponse(
        lifecycleOf("expenses", { paused: true, pausedAt: PAUSED_AT }),
        1,
      );
    }
    if (sent.path === botOperationPath("expenses", "resume")) {
      writes.push(sent);
      return lifecycleResponse(lifecycleOf("expenses"));
    }
    if (sent.path === botOperationPath("expenses", "lifecycle")) {
      return lifecycleResponse(
        lifecycleOf("expenses", {
          paused,
          pausedAt: paused ? PAUSED_AT : null,
        }),
      );
    }
    if (url.includes("/shared-use/bot/")) {
      return Response.json({ apps: [], pending: [] });
    }
    if (url.includes(ME_PATH)) {
      return meResponse({
        user: { id: "me", role: "user", email: "me@example.test", name: "Me" },
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

const PAUSED_AT = "2026-10-09T00:00:00.000Z";

function draw(agent: AgentProfile) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <BotProfile agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

const checked = (element: HTMLElement) =>
  element.getAttribute("aria-checked") === "true" ||
  element.hasAttribute("data-checked");

test("a running Bot's row says Active and its switch is on", async () => {
  serving(false);
  const view = draw(BOT);
  const control = await view.findByRole("switch", { name: "Active" });
  expect(checked(control)).toBe(true);
  expect(view.queryByText("Paused")).toBeNull();
});

test("a paused Bot's Active switch is off, and the row says it is paused", async () => {
  serving(true);
  const view = draw(BOT);
  const control = await view.findByRole("switch", { name: "Active" });
  expect(checked(control)).toBe(false);
  expect(
    await view.findByText(
      /^Paused\. Nothing runs for you until you turn it back on\./,
    ),
  ).toBeTruthy();
});

test("switching a running Bot off pauses it", async () => {
  const writes: SentRequest[] = [];
  serving(false, writes);
  const view = draw(BOT);
  fireEvent.click(await view.findByRole("switch", { name: "Active" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(writes).toEqual([
    {
      method: "POST",
      path: botOperationPath("expenses", "pause"),
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: undefined,
    },
  ]);
});

test("a paused Bot's banner resumes it", async () => {
  const writes: SentRequest[] = [];
  serving(true, writes);
  const view = draw(BOT);
  fireEvent.click(await view.findByRole("button", { name: "Paused. Resume" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(writes).toEqual([
    {
      method: "POST",
      path: botOperationPath("expenses", "resume"),
      key: expect.stringMatching(/^[0-9a-f]{32}$/),
      body: undefined,
    },
  ]);
});
