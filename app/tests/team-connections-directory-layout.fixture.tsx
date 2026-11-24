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
import { TooltipProvider } from "@/components/ui/tooltip";
import { identityKeys } from "@/lib/identity/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { Route as ConnectionRoute } from "@/routes/_authed/_app/connections.$key";
import { Route as BrowseRoute } from "@/routes/_authed/_app/connections.browse.composio";
import { Route as ConnectionsRoute } from "@/routes/_authed/_app/connections.index";
import { ME_PATH, meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import {
  APPS_PATH,
  answerAppsApi,
  appBody,
  type TodayDirectoryApp,
  type TodayServer,
} from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequest,
  appAccessRequestResponse,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import {
  connectionPage,
  MY_CONNECTIONS_PATH,
  myConnectionPath,
  startResponse,
} from "./connections-api";

/**
 * OpenBot Cloud's Connections, the team edition, as a page of its own for
 * team-connections-directory-layout.test.tsx to bundle and load in a browser: the real Connections,
 * Browse apps and app pages, with this page playing the server. `?role=member` signs a member in
 * (an admin otherwise), `?theme=dark` draws it dark. Notion and Rootly are added; Slack, PostHog
 * and Linear are in the directory and not. What the page did is kept in order on `window.__events`.
 */
type Page = Window & { __events: string[] };
const page = window as unknown as Page;
page.__events = [];
setCurrentOrganization("default");

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const role = params.get("role") === "member" ? "member" : "admin";

const directoryApp = (
  slug: string,
  name: string,
  kind: TodayDirectoryApp["connection"]["kind"],
): TodayDirectoryApp => ({
  slug,
  name,
  description: `${name} for your Bots.`,
  logo: null,
  categories: [],
  actionCount: 12,
  connection: { kind },
});
const DIRECTORY = [
  directoryApp("notion", "Notion", "consent"),
  directoryApp("rootly", "Rootly", "fields"),
  directoryApp("slack", "Slack", "consent"),
  directoryApp("posthog", "PostHog", "fields"),
  directoryApp("linear", "Linear", "consent"),
];
const added = (slug: string): TodayServer => ({
  id: `composio-${slug}`,
  title: DIRECTORY.find((app) => app.slug === slug)?.name ?? slug,
  vendor: "composio",
  url: `composio://${slug}`,
  summary: "",
  docsUrl: "",
  provenance: "composio",
  hasCredential: false,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "admin@example.com",
  dynamicClient: false,
  authScheme: slug === "rootly" || slug === "posthog" ? "API_KEY" : "OAUTH2",
  tools: [],
  withdrawn: [],
  accountMode: "personal",
});
let servers = [added("notion"), added("rootly")];
const connected = ["composio-notion"];
let requests = [] as ReturnType<typeof appAccessRequest>[];

const original = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (!path.startsWith("/api/")) return original(input, init);
  if (method !== "GET") page.__events.push(`${method} ${path}`);
  if (path === DEPLOYMENT_PATH)
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: "team",
      hostedSignIn: true,
    });
  if (path === ME_PATH)
    return meResponse({ user: { id: `usr_${role}`, role, name: role } });
  if (method === "POST" && path === APPS_PATH) {
    const { directoryEntryId } = JSON.parse(String(init?.body)) as {
      directoryEntryId: string;
    };
    const app = added(directoryEntryId.replace(/^directory:/, ""));
    servers = [...servers, app];
    return Response.json(appBody(app), { status: 201 });
  }
  if (method === "DELETE" && path.startsWith(`${APPS_PATH}/`)) {
    const id = decodeURIComponent(path.slice(APPS_PATH.length + 1));
    servers = servers.filter((server) => server.id !== id);
    return new Response(null, { status: 204 });
  }
  if (path === APP_ACCESS_REQUESTS_PATH) {
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { appId: string };
      const filed = appAccessRequest({
        id: `req_${body.appId}`,
        appKey: body.appId,
        appTitle: DIRECTORY.find((app) => app.slug === body.appId)?.name ?? "",
        kind: "enable",
        agentId: null,
        botName: null,
      });
      requests = [...requests, filed];
      return appAccessRequestResponse(filed);
    }
    return appAccessRequestsResponse(requests);
  }
  if (method === "POST" && path.endsWith("/connect")) {
    const id = path.split("/").at(-2) ?? "";
    if (path === myConnectionPath(id, "connect"))
      return startResponse({
        authorizationUrl: `https://sign-in.example/${id}`,
      });
  }
  if (path.startsWith(MY_CONNECTIONS_PATH))
    return connectionPage(
      connected.map((serverId) => ({
        serverId,
        connectedAt: "2026-11-23T00:00:00.000Z",
      })),
    );
  const answered = answerAppsApi(url, init, {
    servers,
    directory: DIRECTORY,
    composioConfigured: true,
    provider: "composio",
    botsMayCallBack: true,
  });
  if (answered) return answered;
  return Response.json({ error: "Not found." }, { status: 404 });
}) as typeof fetch;

/** The tab a sign-in claims, recorded rather than opened. */
window.open = (() => {
  page.__events.push("tab claimed");
  const tab = {
    opener: null as unknown,
    closed: false,
    location: { replace: (to: string) => page.__events.push(`tab to ${to}`) },
    close: () => {
      tab.closed = true;
    },
    focus: () => {},
  };
  return tab as unknown as Window;
}) as typeof window.open;

queryClient.setDefaultOptions({ queries: { retry: false } });
// GitHub and Slack aren't offered here: answered once, and never asked again.
queryClient.setQueryDefaults(identityKeys.links(), { staleTime: Infinity });
queryClient.setQueryDefaults(identityKeys.providers(), {
  staleTime: Infinity,
});
queryClient.setQueryData(identityKeys.links(), []);
queryClient.setQueryData(identityKeys.providers(), {
  slack: false,
  github: false,
});

const root = createRootRoute({
  component: () => (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <Outlet />
    </div>
  ),
});
const authed = createRoute({
  id: "/_authed",
  getParentRoute: () => root,
  component: Outlet,
});
const shell = createRoute({
  id: "/_app",
  getParentRoute: () => authed,
  component: Outlet,
});
const routed = (route: unknown, path: string) =>
  (route as { update: (o: unknown) => unknown }).update({
    id: path,
    path,
    getParentRoute: () => shell,
  }) as never;
const router = createRouter({
  routeTree: root.addChildren([
    authed.addChildren([
      shell.addChildren([
        routed(ConnectionsRoute, "/connections/"),
        routed(BrowseRoute, "/connections/browse/composio"),
        routed(ConnectionRoute, "/connections/$key"),
      ]),
    ]),
  ]),
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
