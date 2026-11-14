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
import { cleanup, render, within } from "@testing-library/react";
import { AppsSections } from "@/components/bot-profile/access";
import type { AgentProfile } from "@/lib/agents/queries";
import { ME_PATH, meResponse } from "./accounts-api";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Apps page in the personal edition, before any app is connected.
 *
 * The personal edition has no Your apps section and no admin: every Bot gets every app the person
 * connects. Its empty state used to say "Turn one on under Your apps, or ask an admin", pointing at
 * a section that isn't there and a person who doesn't exist. It names Connections, and links to it.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BOT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: "harbour-pilot",
  name: "Harbour Pilot",
  title: "Harbour Pilot",
  roleDescription: "Brings ships in.",
  avatarSeed: "h",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

/** The personal edition's server, as its one person sees it, with no app connected yet. */
/** The one person of a deployment nobody signs in to, as `/api/me` answers for them. */
const PERSONAL_USER = {
  id: "dev-local-user",
  email: "dev@openbot.local",
  role: "admin" as const,
};

function servePersonal() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://127.0.0.1").pathname;
    if (path === "/api/capabilities")
      return Response.json({ edition: "personal" });
    if (path === `/api/plugins/for/${BOT.id}/apps`)
      return Response.json({ apps: [] });
    if (path === `/api/plugins/for/${BOT.id}`)
      return Response.json({ tools: [], skills: [] });
    if (path === ME_PATH) return meResponse({ user: PERSONAL_USER });
    return Response.json({});
  }) as unknown as typeof fetch;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <AppsSections agent={BOT} />,
  });
  const connections = createRoute({
    getParentRoute: () => root,
    path: "/connections",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, connections]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("in the personal edition, a Bot with no apps points to Connections, not Your apps or an admin", async () => {
  servePersonal();
  const view = draw();

  const title = await view.findByText("No apps yet");
  const empty = title.closest("[data-slot='empty']");
  expect(empty).not.toBeNull();
  const text = empty?.textContent ?? "";
  expect(text).toContain("Connect one on Connections.");
  expect(text).not.toContain("Your apps");
  expect(text).not.toMatch(/admin/i);

  const link = within(empty as HTMLElement).getByRole("link", {
    name: "Connections",
  });
  expect(link.getAttribute("href")).toBe("/connections");

  // And no section on the page names either.
  expect(view.queryByText("Your apps")).toBeNull();
  expect(view.container.textContent ?? "").not.toMatch(/admin/i);
});
