/**
 * A conversation opened while the OpenBot it is connected to can't be reached is not a blank pane.
 *
 * Seen on a real Windows computer: the connection line showed, and under it the conversation's pane
 * was empty, with no title. While the line shows, reads wait for OpenBot instead of failing
 * (lib/desktop/connection-lost.ts), so the conversation's own read stays on its way, and the pane
 * drew nothing while a read was on its way. The header now names the conversation from what the app
 * already holds for it (the sidebar's list), and the pane says, quietly, that it will show here.
 *
 * The conversation's real route under the app's layout ids, the real connection line and the real
 * hold on the app's one query client. Every request gets the answer the desktop app's relay gives
 * when the OpenBot it carries to does not answer; the desktop app stands in at
 * `window.__TAURI_INTERNALS__`.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type InfiniteData,
  onlineManager,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ConnectionBanner } from "@/components/layout/connection-banner";
import { type ChannelPage, channelKeys } from "@/lib/channels/queries";
import { askWhetherOpenBotAnswers } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
const PLACEHOLDER = "This conversation will show here when OpenBot answers.";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:53117/" });
  globalThis.fetch = Object.assign(
    async () =>
      new NativeResponse("OpenBot could not be reached.", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    { preconnect: originalFetch.preconnect },
  );
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      if (command === "plugin:openbot-desktop|connection")
        return { mode: "connected", address: "https://openbot.example.com" };
      throw `command ${command} not found`;
    },
    transformCallback: () => 0,
  };
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  // OpenBot answers again, said with a plain request (reads wait while the connection is lost), so
  // no file after this one starts with the line showing.
  globalThis.fetch = Object.assign(async () => NativeResponse.json({}), {
    preconnect: originalFetch.preconnect,
  });
  await askWhetherOpenBotAnswers();
  queryClient.clear();
  // And online, as the next file's page starts: happy-dom's window here is not the next one's.
  onlineManager.setOnline(true);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

/*
 * TanStack's generated tree wires a file route with update({ id, path, getParentRoute })
 * (app/src/routeTree.gen.ts); the update type tests see leaves those fields out, hence the cast.
 */
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
const conversationRoute = ChannelRoute.update({
  id: "/channel/$channelId",
  path: "/channel/$channelId",
  getParentRoute: () => appRoute,
} as Parameters<typeof ChannelRoute.update>[0] & {
  id: string;
  path: string;
  getParentRoute: () => typeof appRoute;
});

/** The sidebar's list, as the app holds it from before OpenBot stopped answering. */
function listed(name: string) {
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [
      {
        channels: [
          {
            id: "away-channel",
            name,
            agentIds: ["away-bot"],
            threadId: "away-thread",
            active: true,
            lastMessageAt: "2026-11-15T00:00:00.000Z",
            summary: "Overnight changes",
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: "2026-11-15T00:00:00.000Z",
            pinned: false,
            lastReadAt: null,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [""],
  });
}

function opened(channelId: string) {
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([appRoute.addChildren([conversationRoute])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/channel/${channelId}`],
    }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectionBanner />
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

function header(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    '[data-slot="conversation-header"]',
  );
  if (!found) throw new Error("No conversation header");
  return found;
}

test("opened while OpenBot can't be reached, the conversation has its title and says it will show", async () => {
  listed("Release Bot");
  const view = opened("away-channel");
  await view.findByRole(
    "complementary",
    { name: "Connection" },
    { timeout: 5_000 },
  );
  expect(
    await view.findByText(PLACEHOLDER, {}, { timeout: 5_000 }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(header(view.container).textContent).toContain("Release Bot"),
  );
  // Quiet: the line already says why, so nothing here is an alert or red.
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByText(PLACEHOLDER).className).not.toContain("destructive");
}, 15_000);

test("one the app holds nothing for still says it will show, with no title to guess", async () => {
  const view = opened("never-listed");
  await view.findByRole(
    "complementary",
    { name: "Connection" },
    { timeout: 5_000 },
  );
  expect(
    await view.findByText(PLACEHOLDER, {}, { timeout: 5_000 }),
  ).toBeTruthy();
  expect(header(view.container).textContent).not.toContain("Conversation");
  expect(view.queryByRole("alert")).toBeNull();
}, 15_000);
