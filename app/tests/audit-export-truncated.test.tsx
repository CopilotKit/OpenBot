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
import { forgetNativeShellForTests } from "@/lib/native-shell/shell";
import { Route as AuditRoute } from "@/routes/_authed/admin/audit";
import { AUDIT_EXPORT_PATH, auditExport } from "./audit-api";
import { seedAuditPage } from "./seed-audit-page";

beforeAll(() => GlobalRegistrator.register());

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

afterAll(() => GlobalRegistrator.unregister());

function renderAudit() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  seedAuditPage(queryClient, "", { events: [] });
  queryClient.setQueryData(agentKeys.list(false), []);
  const router = createRouter({
    routeTree: createRootRoute({ component: AuditRoute.options.component }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function exportWith(truncatedAt?: number) {
  const asked: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://127.0.0.1");
    asked.push(url);
    if (url.pathname === AUDIT_EXPORT_PATH)
      return auditExport("id\n", truncatedAt);
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:audit";
  URL.revokeObjectURL = () => {};
  const view = renderAudit();
  fireEvent.click(await view.findByText("Export CSV"));
  await view.findByText("Export CSV");
  return Object.assign(view, { asked });
}

// A file that stopped at the cap reads as the whole trail unless the page says otherwise.
test("an export that stopped at the cap says how much the file holds", async () => {
  const view = await exportWith(5000);
  const notice = await view.findByRole("status");
  expect(notice.textContent).toContain("newest 5,000 events");
});

test("a whole export says nothing extra", async () => {
  const view = await exportWith();
  expect(view.queryByRole("status")).toBeNull();
  // The file was asked of the API's export, with the page's view and no paging.
  const exported = view.asked.find((url) => url.pathname === AUDIT_EXPORT_PATH);
  expect(exported?.searchParams.has("cursor")).toBe(false);
  expect(exported?.searchParams.has("format")).toBe(false);
});

/*
 * The phone app's web view doesn't take a download yet, and this one is a `blob:` address let go at
 * once, which it could not fetch later: no Export there.
 */
test("inside the phone app's native shell there is no Export", async () => {
  const page = window as { __OPENBOT_NATIVE_SHELL__?: unknown };
  page.__OPENBOT_NATIVE_SHELL__ = {
    platform: "android",
    version: "0.1",
    bridge: 1,
  };
  forgetNativeShellForTests();
  globalThis.fetch = (async () =>
    Response.json(
      { error: "not served" },
      { status: 404 },
    )) as unknown as typeof fetch;
  try {
    const view = renderAudit();
    await view.findByText("Refresh");
    expect(view.queryByText("Export CSV")).toBeNull();
  } finally {
    delete page.__OPENBOT_NATIVE_SHELL__;
    forgetNativeShellForTests();
  }
});
