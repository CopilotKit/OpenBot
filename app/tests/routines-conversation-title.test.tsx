import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { RoutinesList } from "@/components/routines/routines-list";
import type { RoutinesPage } from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Where a routine posts, named the way the sidebar names the conversation.
 *
 * Found on a vanilla install: every routine on the Routines page said it posted to "General
 * Assistant". That is the channel's NAME, and a channel is named after its Bots, so every one of a
 * person's conversations with General Assistant is called that. The sidebar shows each by its title
 * ("15-Minute EKS UTC Routine"), and that is the only name the person knows it by.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

/** The Routines endpoint's answer, as the server writes it for two routines with one Bot. */
const PAGE: RoutinesPage = {
  routines: [
    {
      id: "routine-eks",
      agentId: "general-assistant",
      schedule: "Every 15 minutes",
      timezone: "UTC",
      instruction:
        "Reply with the current UTC time and the words 'routine check from EKS'.",
      title: null,
      channel: {
        id: "conversation-eks",
        name: "General Assistant",
        title: "15-Minute EKS UTC Routine",
        gone: false,
      },
      enabled: true,
      nextRunAt: "2026-11-05T07:45:00.000Z",
      lastRun: null,
    },
    {
      id: "routine-new",
      agentId: "general-assistant",
      schedule: "Every day at 09:00",
      timezone: "UTC",
      instruction: "Post the morning summary.",
      title: null,
      channel: {
        id: "conversation-new",
        name: "General Assistant",
        title: "New conversation",
        gone: false,
      },
      enabled: true,
      nextRunAt: "2026-11-06T09:00:00.000Z",
      lastRun: null,
    },
  ],
  sweep: { lastSweptAt: "2026-11-05T07:30:00.000Z", working: true },
};

function draw() {
  global.fetch = (async (input: RequestInfo | URL) =>
    String(input).startsWith("/api/routines")
      ? Response.json(PAGE)
      : Response.json({})) as unknown as typeof fetch;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <RoutinesList /> }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("each routine names its conversation by the sidebar's title, not by its Bot", async () => {
  const view = draw();

  const eks = (await view.findByText("15-Minute EKS UTC Routine")).closest("a");
  expect(eks?.getAttribute("href")).toBe("/channel/conversation-eks");
  const fresh = view.getByText("New conversation").closest("a");
  expect(fresh?.getAttribute("href")).toBe("/channel/conversation-new");
  expect(view.queryByText("General Assistant")).toBeNull();
});
