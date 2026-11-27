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
import { Route as BrowseRoute } from "@/routes/_authed/_app/connections.browse.composio";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  APPS_SETTING_PATH,
  appsSettingResponse,
  DEPLOYMENT_PATH,
} from "./admin-settings-api";
import {
  APP_DIRECTORY_PATH,
  answerAppsApi,
  type TodayDirectoryApp,
} from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
} from "./bot-grants-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";

/**
 * Browse apps on a directory the size of the live one, as a page of its own for
 * browse-apps-pages.test.tsx to bundle and load in a browser: the real screen, with this page
 * playing the server. Composio listed 2,048 apps on 2026-11-26; this one holds 1,800, every tenth
 * taking a key. Each page of the directory takes as long to answer as a page did on the hosted
 * service before it was fixed (`?latency=<ms>`, 300 by default), so a screen that reads every page
 * before drawing one is as slow here as it was there. `?theme=dark` draws it dark.
 *
 * Every read of the directory is kept in order on `window.__directoryReads`, as the query it sent.
 */
type Page = Window & { __directoryReads: string[] };
const page = window as unknown as Page;
page.__directoryReads = [];
setCurrentOrganization("default");

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const latency = Number(params.get("latency") ?? 300);

/** The apps, named so their order by title is their order here: App 0000 to App 1799. */
const DIRECTORY: TodayDirectoryApp[] = Array.from(
  { length: 1_800 },
  (_, index) => {
    const number = String(index).padStart(4, "0");
    return {
      slug: `app${number}`,
      name: `App ${number}`,
      description: `What App ${number} does for your Bots.`,
      logo: null,
      categories: [],
      actionCount: 12 + (index % 40),
      connection: { kind: index % 10 === 9 ? "fields" : "consent" },
    };
  },
);

const original = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  if (!path.startsWith("/api/")) return original(input, init);
  if (path === DEPLOYMENT_PATH)
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: "team",
      hostedSignIn: true,
    });
  if (path === ME_PATH)
    return meResponse({
      user: { id: "usr_admin", role: "admin", name: "Sam" },
    });
  if (path === APPS_SETTING_PATH) return appsSettingResponse(false);
  if (path === APP_ACCESS_REQUESTS_PATH) return appAccessRequestsResponse([]);
  if (path.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
  if (path === APP_DIRECTORY_PATH) {
    page.__directoryReads.push(url.search);
    await new Promise((resolve) => setTimeout(resolve, latency));
  }
  const answered = answerAppsApi(url, init, {
    servers: [],
    directory: DIRECTORY,
    composioConfigured: true,
    provider: "composio",
    botsMayCallBack: true,
  });
  if (answered) return answered;
  return Response.json({ error: "Not found." }, { status: 404 });
}) as typeof fetch;

queryClient.setDefaultOptions({ queries: { retry: false } });
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
  // The page scrolls as the app's own column does: the window, under a full-height frame.
  component: () => (
    <div className="min-h-svh bg-background text-foreground">
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
      shell.addChildren([routed(BrowseRoute, "/connections/browse/composio")]),
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
