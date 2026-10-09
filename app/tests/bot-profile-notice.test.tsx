import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { BotProfile } from "@/components/bot-profile/profile";
import type { AgentProfile } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot whose Shared-app calls are being refused right now says so on its own page, to whoever may
 * manage it: the refusal is about the Bot's present reach, not only about the moment of publishing.
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

function serving() {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/shared-use/bot/")) {
      return Response.json({
        apps: [{ serverId: "gmail", title: "Gmail", covered: false }],
        pending: [],
      });
    }
    if (url.endsWith("/lifecycle")) {
      return Response.json({
        lifecycle: {
          agentId: "expenses",
          paused: false,
          pausedAt: null,
          notify: "all",
        },
      });
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

test("whoever manages the Bot is told its Shared-app calls are refused", async () => {
  serving();
  const view = draw(BOT);
  expect(
    await view.findByText(/Gmail calls from this Bot are refused/),
  ).toBeTruthy();
});

test("someone who cannot manage the Bot is not shown the warning", async () => {
  serving();
  const view = draw({ ...BOT, canManage: false, mine: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(view.queryByText(/calls from this Bot are refused/)).toBeNull();
});

test("the Message row shows the chevron every row that goes somewhere carries", async () => {
  serving();
  const view = draw(BOT);
  const row = (await view.findByText("Message Expenses")).closest("a");
  expect(row?.querySelector(".tabler-icon-chevron-right")).not.toBeNull();
});
