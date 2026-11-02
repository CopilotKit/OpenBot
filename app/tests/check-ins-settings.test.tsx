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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { CheckInsSection } from "@/components/settings/check-ins";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { authKeys } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/*
 * The person's own switch for every Bot's check-ins, in Settings, Notifications, and what it says
 * when an admin turned check-ins off for them. Each Bot's own check-ins on its Memory page say the
 * same, since none of them runs while either is off.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

let proactive: "on" | "off" = "on";
let allowed = true;
const writes: { request: string; body: unknown }[] = [];

function serving() {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const preferences = () => ({
      messageListEmphasis: "thread",
      selfHostBannerDismissed: true,
      narration: null,
      skin: "openbot",
      proactive,
    });
    if (path === "/api/settings/preferences" && method === "PATCH") {
      const body = JSON.parse(String(init?.body));
      writes.push({ request: `${method} ${path}`, body });
      proactive = body.proactive;
      return Response.json({ preferences: preferences() });
    }
    if (path === "/api/settings/preferences")
      return Response.json({ preferences: preferences() });
    if (path === "/api/proactive/settings")
      return Response.json({
        settings: [
          {
            id: "p1",
            agentId: "expenses",
            channelId: "c1",
            focus: "",
            enabled: true,
            intervalMinutes: 60,
            nextRunAt: "2026-10-30T12:00:00Z",
            lastRunAt: null,
            lastStatus: "idle",
            lastError: null,
          },
        ],
        allowed,
      });
    if (path.startsWith("/api/agents"))
      return Response.json({ agents: [{ id: "expenses", name: "Expenses" }] });
    return Response.json({ error: "not served" }, { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  proactive = "on";
  allowed = true;
  // A save writes the stored preferences into the app's one cache, so the switch draws from it.
  queryClient.clear();
  queryClient.setQueryData(authKeys.currentUser(), {
    id: "alice",
    email: "alice@example.com",
    name: "Alice",
    role: "user",
  });
});

async function draw(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("turning check-ins off for all Bots saves it and says so", async () => {
  serving();
  const view = await draw(<CheckInsSection />);
  const toggle = await view.findByRole("switch", {
    name: "Check-ins for all your Bots",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(
    view.getByText("On. Each Bot's own check-ins are on its Memory page."),
  ).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(writes).toEqual([
      {
        request: "PATCH /api/settings/preferences",
        body: { proactive: "off" },
      },
    ]),
  );
  expect(
    await view.findByText("Off. None of your Bots check in for you."),
  ).toBeTruthy();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

test("turned off by an admin, the switch says who and can't be turned back on", async () => {
  allowed = false;
  serving();
  const view = await draw(<CheckInsSection />);
  expect(await view.findByText("Turned off by your admin.")).toBeTruthy();
  const toggle = view.getByRole("switch", {
    name: "Check-ins for all your Bots",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.hasAttribute("data-disabled")).toBe(true);
});

test("a Bot's own check-ins say they are off for all your Bots, and won't run now", async () => {
  proactive = "off";
  serving();
  const view = await draw(<ProactiveResearchSettings agentId="expenses" />);
  expect(
    await view.findByText(/You turned off check-ins for all your Bots in/),
  ).toBeTruthy();
  expect(view.getByRole("link", { name: "Notifications" })).toBeTruthy();
  expect(view.getByText("Every hour · Off for all your Bots")).toBeTruthy();
});

test("a Bot's own check-ins say an admin turned them off", async () => {
  allowed = false;
  serving();
  const view = await draw(<ProactiveResearchSettings agentId="expenses" />);
  expect(
    await view.findByText("Your admin turned off check-ins for you."),
  ).toBeTruthy();
  expect(view.getByText("Every hour · Turned off by your admin")).toBeTruthy();
});
