import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotProfile } from "@/components/bot-profile/profile";
import type { AgentProfile } from "@/lib/agents/queries";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  botNotificationSettingsPath,
  notificationsResponse,
} from "./notifications-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's page, Notifications: how much this Bot may reach the person outside OpenBot is the person's
 * own setting for that Bot, saved through the API under their address, by the Bot's id as the Bots API
 * names it, a Bot id a path segment can't hold included.
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
  id: "team/risk",
  name: "Risk",
  title: "Finance",
  roleDescription: "Watches exposure.",
  avatarSeed: "r",
  visibility: "private",
  endpoint: null,
  builtIn: false,
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

const writes: {
  method: string;
  url: string;
  key: string | null;
  body: unknown;
}[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method !== "GET")
      writes.push({
        method,
        url,
        key: new Headers(init?.headers).get("idempotency-key"),
        body,
      });
    if (url.endsWith("/lifecycle")) {
      return Response.json({
        lifecycle: {
          agentId: BOT.id,
          paused: false,
          pausedAt: null,
          notify: "all",
        },
      });
    }
    if (url.includes(ME_PATH)) {
      return meResponse({
        user: { id: "me", role: "user", email: "me@example.test", name: "Me" },
      });
    }
    return (
      notificationsResponse(method, url, {}, body) ??
      new Response(null, { status: 404 })
    );
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

test("choosing how much a Bot may send saves it as the person's own setting for that Bot", async () => {
  serving();
  const view = draw(BOT);
  const user = userEvent.setup({ document });
  await user.click(
    await view.findByRole("combobox", { name: "Notifications" }),
  );
  await user.click(
    await view.findByRole("option", { name: "Only when it needs me" }),
  );
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({
    method: "PATCH",
    url: botNotificationSettingsPath("team/risk"),
    body: { notify: "needs_input" },
  });
  // The Bot's id is one segment of the address, and the write is made once whatever retries it.
  expect(writes[0]?.url).toEndWith("/bot-notification-settings/team%2Frisk");
  expect(writes[0]?.key).toBeTruthy();
});
