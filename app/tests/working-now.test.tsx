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
import { WorkingNow } from "@/components/channels/working-now";
import type { ChannelSummary } from "@/lib/channels/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * Home's note about a Bot that is working right now: drawn only while a turn runs somewhere, and a way to that
 * conversation.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "channel_a",
    name: "Personal Assistant",
    agentIds: ["picked-harness"],
    threadId: "thread-a",
    active: true,
    summary: "Plan the Lisbon trip budget",
    opening: null,
    lastMessage: null,
    lastMessageAgentId: null,
    lastMessageAt: null,
    createdAt: "2026-11-08T07:00:00.000Z",
    pinned: false,
    lastReadAt: null,
    ...overrides,
  } as ChannelSummary;
}

function draw(channels: ChannelSummary[] | undefined) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <WorkingNow channels={channels} />,
    }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("while a Bot works, home says so and links to that conversation", async () => {
  const view = draw([
    channel({ id: "channel_idle", summary: "Book the dentist" }),
    channel({ busy: true }),
  ]);
  const link = await view.findByRole("link", {
    name: /Personal Assistant is working/,
  });
  expect(link.getAttribute("href")).toBe("/channel/channel_a");
  expect(link.textContent).toContain("Plan the Lisbon trip budget");
});

test("with nothing working, home has no note at all", async () => {
  const view = draw([channel({})]);
  await settleReactWork();
  expect(view.queryByRole("link")).toBeNull();
});
