import { QueryClientProvider } from "@tanstack/react-query";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { PageShell } from "@/components/layout/page-shell";
import { AccessRequestsSection } from "@/components/plugins/access-requests";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import {
  APPS_SETTING_PATH,
  appsSettingResponse,
  DEPLOYMENT_PATH,
  deploymentResponse,
} from "./admin-settings-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequest,
  appAccessRequestBody,
} from "./bot-grants-api";

/**
 * An admin's Requests section with three requests waiting, as a page of its own for
 * access-requests-layout.test.tsx to bundle and load in a browser: a Bot asking for Gmail, a Bot
 * asking for Notion to be turned on, and a Bot asking for one Google Calendar action. This page
 * plays the server.
 *
 * `?apps=open` is an organization whose apps are open, the default; locked down otherwise.
 * `?theme=dark` draws it dark.
 */
setCurrentOrganization("default");

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const open = params.get("apps") === "open";

const asked = new Date(Date.now() - 5 * 60_000).toISOString();
const REQUESTS = [
  appAccessRequest({ id: "req_gmail", createdAt: asked }),
  appAccessRequest({
    id: "req_notion",
    kind: "enable",
    appKey: "notion",
    appTitle: "Notion",
    agentId: "research",
    botName: "Research Assistant",
    requesterName: "Sam Lee",
    requesterEmail: "sam@example.com",
    createdAt: asked,
  }),
  appAccessRequest({
    id: "req_calendar",
    appKey: "composio-googlecalendar",
    appTitle: "Google Calendar",
    botName: "Calendar Bot",
    actions: ["composio-googlecalendar/GOOGLECALENDAR_PATCH_EVENT"],
    createdAt: asked,
  }),
];

const original = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return original(input, init);
  if (path === DEPLOYMENT_PATH) return deploymentResponse();
  if (path === APPS_SETTING_PATH) return appsSettingResponse(!open);
  if (path === APP_ACCESS_REQUESTS_PATH)
    return Response.json({
      appAccessRequests: REQUESTS.map(appAccessRequestBody),
      nextCursor: null,
    });
  return Response.json({ error: "Not found." }, { status: 404 });
}) as typeof fetch;

queryClient.setDefaultOptions({ queries: { retry: false } });

const root = createRootRoute({ component: Outlet });
const inbox = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: () => (
    <div className="min-h-svh bg-background text-foreground">
      <PageShell title="Apps">
        <AccessRequestsSection />
      </PageShell>
    </div>
  ),
});
const grants = createRoute({
  getParentRoute: () => root,
  path: "/admin/plugins/$key/bots/$agentId",
  component: () => null,
});
const router = createRouter({
  routeTree: root.addChildren([inbox, grants]),
  history: createBrowserHistory(),
});

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
