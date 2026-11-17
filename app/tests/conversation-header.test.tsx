/**
 * The conversation's header names it. While the conversation is on its way it names nothing, and
 * when it could not be loaded (here OpenBot can't be reached: every request gets the answer the
 * desktop app's relay gives when the OpenBot it carries to does not answer) it says "Conversation".
 * A person never reads "Channel": the word for it in OpenBot is conversation.
 *
 * The conversation's real route under the app's layout ids, on the app's one query client.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { queryClient } from "@/query-client";
import { Route as ChannelRoute } from "@/routes/_authed/_app/channel/$channelId";

const originalFetch = globalThis.fetch;
/** Held until released, to look at the header before the conversation's answer. */
let gate: Promise<void> = Promise.resolve();

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:53111/" });
  globalThis.fetch = Object.assign(
    async () => {
      await gate;
      return new Response("OpenBot could not be reached.", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.removeItem("openbot-places");
  gate = Promise.resolve();
});
afterAll(async () => {
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

function opened() {
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([appRoute.addChildren([conversationRoute])]),
    ]),
    history: createMemoryHistory({ initialEntries: ["/channel/c-unreached"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
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

test("a conversation that could not be loaded is headed Conversation, never Channel", async () => {
  let release: () => void = () => {};
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const view = opened();
  await waitFor(() => header(view.container));
  // On its way: the header names nothing yet.
  expect(header(view.container).textContent).not.toContain("Channel");
  expect(header(view.container).textContent).not.toContain("Conversation");

  release();
  // The app asks once more before it gives up (query-client.ts).
  await view.findByRole("alert", undefined, { timeout: 5_000 });
  await waitFor(() =>
    expect(header(view.container).textContent).toContain("Conversation"),
  );
  expect(view.container.textContent).not.toContain("Channel");
}, 15_000);

test("with places on, the conversation's header has one Back", async () => {
  localStorage.setItem("openbot-places", "on");
  let release: () => void = () => {};
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const view = opened();
  try {
    await waitFor(() => header(view.container));
    expect(
      within(header(view.container)).getByRole("button", { name: "Back" }),
    ).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Back" })).toHaveLength(1);
  } finally {
    release();
  }
});

test("with places off, the conversation's header has no Back", async () => {
  let release: () => void = () => {};
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const view = opened();
  try {
    await waitFor(() => header(view.container));
    expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  } finally {
    release();
  }
});
