import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AddServerPage } from "@/components/connections/add-server-page";
import { PluginsListPage } from "@/components/manage/plugins-list-page";
import { BrokerDirectory } from "@/components/plugins/broker-directory";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { answerAppsApi } from "./apps-api";

beforeAll(() => GlobalRegistrator.register());
const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

function screen(component: () => React.ReactNode, personal = false) {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answered = answerAppsApi(input, init, {
      servers: [],
      catalogue: [],
      directory: [],
      provider: "composio",
      composioConfigured: true,
    });
    if (answered) return answered;
    return Response.json({
      connections: [],
      requests: [],
      accounts: [],
      rules: [],
      pending: [],
      items: [],
      nextCursor: null,
    });
  }) as typeof fetch;
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData<AuthenticatedUser>(authKeys.currentUser(), () => ({
    id: "admin",
    email: "admin@example.test",
    role: "admin",
    onboarding: null,
  }));
  cache.setQueryData(deploymentCapabilitiesQueryOptions().queryKey, {
    edition: personal ? "personal" : "team",
    generativeUi: false,
    selfHostBanner: false,
    localEvaluation: personal,
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/test",
    component,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/test"] }),
  });
  return render(
    <QueryClientProvider client={cache}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}
test("Admin Plugins offers a native row for custom MCP servers", async () => {
  const view = screen(() => <PluginsListPage />);
  const row = await view.findByRole("link", { name: /Add custom MCP server/ });
  expect(row.getAttribute("href")).toBe("/admin/plugins/new");
});
test("team directory links its Add MCP server button to Admin", async () => {
  const view = screen(() => <BrokerDirectory provider="composio" />);
  const button = await view.findByRole("button", { name: "Add MCP server" });
  expect(button.getAttribute("href")).toBe("/admin/plugins/new");
});
test("personal directory keeps the existing Connections registration flow", async () => {
  const view = screen(() => <BrokerDirectory provider="composio" />, true);
  const button = await view.findByRole("button", { name: "Add MCP server" });
  expect(button.getAttribute("href")).toBe("/connections/new");
});
test("the reused native form returns an admin to Plugins on Back and Cancel", async () => {
  const view = screen(() => (
    <AddServerPage
      back={{ label: "Plugins", linkProps: { to: "/admin/plugins" } }}
    />
  ));
  const back = await view.findByRole("button", {
    name: "Plugins",
  });
  expect(back.getAttribute("href")).toBe("/admin/plugins");
  expect(
    view.getByRole("button", { name: "Cancel" }).getAttribute("href"),
  ).toBe("/admin/plugins");
  fireEvent.change(view.getByLabelText("Name"), {
    target: { value: "DeepWiki" },
  });
  fireEvent.change(view.getByLabelText("Server address"), {
    target: { value: "https://mcp.deepwiki.com/mcp" },
  });
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: "Add server" }).hasAttribute("disabled"),
    ).toBe(false),
  );
});
test("Connections callers retain their original Back and Cancel destinations", async () => {
  const view = screen(() => <AddServerPage />);
  const back = await view.findByRole("button", {
    name: "Connections",
  });
  expect(back.getAttribute("href")).toBe("/connections");
  expect(
    view.getByRole("button", { name: "Cancel" }).getAttribute("href"),
  ).toBe("/connections");
});
