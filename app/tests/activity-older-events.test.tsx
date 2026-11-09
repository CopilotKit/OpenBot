import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import { Route as ActivityRoute } from "@/routes/_authed/settings/_personal/activity";
import { settleReactWork } from "./settle-react-work";

/*
 * FOUND ON A USED INSTALL (personal edition, 1.0 RC1 candidate, 298 events in the trail): Settings >
 * Activity showed the newest 50 events as "49 events", as if that were everything, with no way to
 * see an older one. The server answered `nextCursor` and the page never asked for it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());

const originalFetch = globalThis.fetch;
let asked: URL[] = [];

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/** A row as `GET /api/admin/audit-events` answers it: the stored columns, `createdAt` as ISO. */
function storedRow(n: number) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    actorUserId: "dev",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: "personal-assistant",
    payload: {
      bot: "personal-assistant",
      action: "computer_click",
      element: { name: `Button ${n}`, role: "button" },
    },
    // Newest first, a minute apart: row 1 is the newest.
    createdAt: new Date(
      Date.UTC(2026, 10, 8, 12, 0) - n * 60_000,
    ).toISOString(),
  };
}

// The server's own cursor encoding (`encodeCursor` in server/src/audit.ts): the last row's time and id.
const CURSOR = Buffer.from(
  JSON.stringify({ createdAt: storedRow(50).createdAt, id: storedRow(50).id }),
).toString("base64url");

/** The server's two pages: 50 rows and where the next starts, then the last 10 with no cursor. */
function serve(url: URL) {
  if (!url.searchParams.has("cursor")) {
    return {
      events: Array.from({ length: 50 }, (_, i) => storedRow(i + 1)),
      nextCursor: CURSOR,
    };
  }
  // `nextCursor` is undefined on the last page, which `context.json` leaves out of the body.
  return { events: Array.from({ length: 10 }, (_, i) => storedRow(i + 51)) };
}

test("Activity names what it shows as the newest events, and Show older events reaches the rest", async () => {
  asked = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://127.0.0.1");
      if (url.pathname === "/api/admin/audit-events") {
        asked.push(url);
        return Response.json(serve(url));
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  queryClient.setQueryData(pluginKeys.page(), {
    catalogue: [],
    servers: [],
    skills: [],
  });
  queryClient.setQueryData(agentKeys.list(false), [
    { id: "personal-assistant", name: "Personal Assistant" },
  ]);
  queryClient.setQueryData(agentKeys.list(true), []);
  const Page = ActivityRoute.options.component as ComponentType;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Page /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  // The first page, and a count that does not pass itself off as the whole trail.
  await view.findByText("Newest 50 events");
  expect(view.container.textContent).toContain("Button 50");
  expect(view.container.textContent).not.toContain("Button 51");

  fireEvent.click(view.getByRole("button", { name: "Show older events" }));

  // The older page, asked for with the same view and the server's cursor, under the newer rows.
  await view.findByText("60 events");
  expect(view.container.textContent).toContain("Button 60");
  expect(view.container.querySelectorAll("tbody tr[data-outcome]").length).toBe(
    60,
  );
  expect(asked).toHaveLength(2);
  expect(asked[1]?.searchParams.get("cursor")).toBe(CURSOR);
  expect(asked[1]?.searchParams.get("excludeEventType")).toBe(
    asked[0]?.searchParams.get("excludeEventType") ?? "missing",
  );
  // The last page has no cursor, so there is nothing older to offer.
  await waitFor(() =>
    expect(
      view.queryByRole("button", { name: "Show older events" }),
    ).toBeNull(),
  );
});
