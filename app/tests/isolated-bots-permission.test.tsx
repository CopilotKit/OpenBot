import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { CapabilitiesSection } from "@/components/admin/controls/capabilities-section";
import { getListCapabilitiesMockHandler } from "@/lib/api/generated/capabilities/capabilities.msw";
import type { Capability } from "@/lib/api/generated/model";
import { getListNetworkPoliciesMockHandler } from "@/lib/api/generated/network-policies/network-policies.msw";
import { getGetOrganizationSettingsMockHandler } from "@/lib/api/generated/organization-settings/organization-settings.msw";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { settingsBody } from "./admin-settings-api";
import { settleReactWork } from "./settle-react-work";

/**
 * Admin, Permissions, on an OpenBot that gives no Bot a computer of its own: its operator turned isolated Bots off
 * for every organization, or its Bots share one computer. The "Isolated Bots" row says so and its switch can't be
 * turned on, though the organization's own setting is on. Every other switch is untouched. Where the OpenBot can
 * give a Bot one, the row is the admin's as before.
 *
 * The server is the spec's own MSW handlers; the deployment's answer is what `GET /deployment` gives the screens.
 */
const capabilities: Capability[] = [
  {
    id: "isolatedComputers",
    title: "Isolated Bots",
    description:
      "People may give a Bot a computer of its own instead of sharing theirs.",
    default: true,
    organization: true,
    roles: {},
    groups: {},
    teams: {},
  },
  {
    id: "cloudBrowser",
    title: "Cloud browser",
    description: "Bots may browse the web on a computer of their own.",
    default: true,
    organization: null,
    roles: {},
    groups: {},
    teams: {},
  },
];

const server = setupServer(
  getGetOrganizationSettingsMockHandler(() => settingsBody({}) as never),
  getListCapabilitiesMockHandler(() => ({ capabilities, nextCursor: null })),
  // The overview reads the network policies with the switches.
  getListNetworkPoliciesMockHandler(() => ({
    networkPolicies: [],
    nextCursor: null,
  })),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  setCurrentOrganization("default");
  queryClient.clear();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

async function permissions(isolatedBots: boolean) {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    isolatedBots,
    botComputers: true,
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: CapabilitiesSection }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("where no Bot can have a computer of its own, the row says so and the switch can't be turned on", async () => {
  const view = await permissions(false);
  const isolated = await view.findByRole("switch", { name: "Isolated Bots" });
  expect(isolated.getAttribute("aria-checked")).toBe("false");
  expect(
    isolated.hasAttribute("disabled") ||
      isolated.getAttribute("aria-disabled") === "true" ||
      isolated.hasAttribute("data-disabled"),
  ).toBe(true);
  expect(view.container.textContent).toContain(
    "This OpenBot can't give a Bot a computer of its own.",
  );
  // Every other switch is the admin's as before.
  const browser = view.getByRole("switch", { name: "Cloud browser" });
  expect(browser.getAttribute("aria-checked")).toBe("true");
  expect(browser.hasAttribute("data-disabled")).toBe(false);
});

test("where it can, the row is the admin's switch as before", async () => {
  const view = await permissions(true);
  const isolated = await view.findByRole("switch", { name: "Isolated Bots" });
  expect(isolated.getAttribute("aria-checked")).toBe("true");
  expect(isolated.hasAttribute("data-disabled")).toBe(false);
  expect(view.container.textContent).toContain(
    "People may give a Bot a computer of its own instead of sharing theirs.",
  );
  expect(view.container.textContent).not.toContain(
    "This OpenBot can't give a Bot a computer of its own.",
  );
});
