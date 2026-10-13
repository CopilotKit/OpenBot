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
import { agentKeys } from "@/lib/agents/queries";
import { auditKeys } from "@/lib/audit/queries";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";

beforeAll(() => GlobalRegistrator.register());

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

afterAll(() => GlobalRegistrator.unregister());

async function exportWith(headers: Record<string, string>) {
  globalThis.fetch = (async () =>
    new Response("id\n", {
      headers: { "content-type": "text/csv", ...headers },
    })) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:audit";
  URL.revokeObjectURL = () => {};
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClient.setQueryData([...auditKeys.all, ""], { events: [] });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: AuditRoute.options.component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  fireEvent.click(await view.findByText("Export CSV"));
  await view.findByText("Export CSV");
  return view;
}

// A file that stopped at the cap reads as the whole trail unless the page says otherwise.
test("an export that stopped at the cap says how much the file holds", async () => {
  const view = await exportWith({ "x-audit-export-truncated": "5000" });
  const notice = await view.findByRole("status");
  expect(notice.textContent).toContain("newest 5,000 events");
});

test("a whole export says nothing extra", async () => {
  const view = await exportWith({});
  expect(view.queryByRole("status")).toBeNull();
});
