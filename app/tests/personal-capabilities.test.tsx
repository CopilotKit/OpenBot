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
import { cleanup, render } from "@testing-library/react";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { deploymentKeys } from "@/lib/deployment/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(edition: "team" | "personal", at: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  const root = createRootRoute({ component: Outlet });
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <CapabilitiesShell>body</CapabilitiesShell>,
    });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      page("/capabilities/skills"),
      page("/capabilities/memory"),
    ]),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("in the personal edition, Skills is its own page that goes back to Bots", async () => {
  const view = draw("personal", "/capabilities/skills");
  expect(await view.findByRole("heading", { name: "Skills" })).toBeTruthy();
  expect(view.getByRole("button", { name: /Bots/ }).getAttribute("href")).toBe(
    "/bots",
  );
  expect(view.queryByRole("navigation", { name: "Capabilities" })).toBeNull();
});

test("the team edition keeps the Capabilities page and its tabs", async () => {
  const view = draw("team", "/capabilities/skills");
  expect(
    await view.findByRole("heading", { name: "Capabilities" }),
  ).toBeTruthy();
  expect(view.getByRole("navigation", { name: "Capabilities" })).toBeTruthy();
});
