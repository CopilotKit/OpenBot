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
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

function serving(paused: boolean, writes: string[] = []) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST" && /\/(pause|resume)$/.test(url)) {
      writes.push(url.endsWith("/pause") ? "pause" : "resume");
      return Response.json({
        lifecycle: {
          agentId: "expenses",
          paused: url.endsWith("/pause"),
          pausedAt: null,
          notify: "all",
        },
      });
    }
    if (url.endsWith("/lifecycle")) {
      return Response.json({
        lifecycle: {
          agentId: "expenses",
          paused,
          pausedAt: paused ? "2026-10-09T00:00:00.000Z" : null,
          notify: "all",
        },
      });
    }
    if (url.includes("/shared-use/bot/")) {
      return Response.json({ apps: [], pending: [] });
    }
    if (url.includes("/api/me")) {
      return Response.json({
        user: { id: "me", role: "user", email: "me@example.test", name: "Me" },
      });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

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
  expect(await view.findByText(/^Paused\. No routine/)).toBeTruthy();
});

test("switching a running Bot off pauses it", async () => {
  const writes: string[] = [];
  serving(false, writes);
  const view = draw(BOT);
  fireEvent.click(await view.findByRole("switch", { name: "Active" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(writes).toEqual(["pause"]);
});
