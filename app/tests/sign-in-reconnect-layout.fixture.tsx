import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import { connectAppRefusal } from "@openbot/shared/connect-prompt";
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
import { ConversationView } from "@/components/channels/conversation-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { identityKeys } from "@/lib/identity/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { queryClient } from "@/query-client";
import { Route as ConnectionRoute } from "@/routes/_authed/_app/connections.$key";
import { Route as ConnectionsRoute } from "@/routes/_authed/_app/connections.index";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  APPS_SETTING_PATH,
  appsSettingResponse,
  DEPLOYMENT_PATH,
} from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import {
  answerAppsApi,
  type TodayCatalogueItem,
  type TodayServer,
} from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
  botAppPath,
  botAppResponse,
} from "./bot-grants-api";
import { botPath } from "./bots-api";
import {
  connectionPage,
  MY_CONNECTIONS_PATH,
  startResponse,
} from "./connections-api";

/**
 * Reconnect on apps that sign in, as a page of its own for sign-in-reconnect-layout.test.tsx to
 * bundle and load in a browser, in the team edition as a member. `/` is a conversation whose Bot
 * found the person's Gmail account lost (Gmail signs in through the directory), with the real card;
 * `/connections` is the real Connections, and `/connections/<app>` the app's own page. Notion (signed
 * in to by OpenBot itself) is connected and its grant was withdrawn at Notion.
 *
 * `?held=1` holds the connect route's answer until `window.__release()`, so the press's pending
 * state can be looked at. `?theme=dark` draws it dark. What the page did is kept in order on
 * `window.__events`: each write, each tab claimed, and where the tab is sent.
 */
type Page = Window & { __events: string[] };
const page = window as unknown as Page;
page.__events = [];
setCurrentOrganization("default");

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const held = params.get("held") === "1";
let release: () => void = () => {};
const connectHeld = held
  ? new Promise<void>((resolve) => {
      release = resolve;
    })
  : Promise.resolve();
(window as unknown as { __release: () => void }).__release = () => release();

const BOT = "assistant";
const notionEntry: TodayCatalogueItem = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};
const notion: TodayServer = {
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  url: "https://mcp.notion.com/mcp",
  summary: "Pages and databases.",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "admin@example.com",
  dynamicClient: false,
  signIn: false,
  authScheme: null,
  tools: [],
  withdrawn: [],
  accountMode: null,
  ownerGrants: "any",
};
const gmail: TodayServer = {
  ...notion,
  id: "composio-gmail",
  title: "Gmail",
  vendor: "composio",
  url: "composio://gmail",
  summary: "Read and send email.",
  provenance: "composio",
  hasCredential: false,
  authScheme: "OAUTH2",
  accountMode: "personal",
};

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
    return meResponse({ user: { id: "usr_me", role: "member", name: "Me" } });
  if (path === APPS_SETTING_PATH) return appsSettingResponse(false);
  if (path === botPath(BOT))
    return Response.json({
      bot: { id: BOT, name: "Personal Assistant", mine: true },
    });
  // Gmail reads as ready: the account was lost at the vendor, which only the Bot's refusal knows.
  if (path === botAppPath(BOT, gmail.id))
    return botAppResponse(
      appAccess({
        key: gmail.id,
        displayName: "Gmail",
        connect: "consent",
        state: "ready",
        connectedAt: "2026-11-01T09:00:00.000Z",
      }),
    );
  if (path === APP_ACCESS_REQUESTS_PATH) return appAccessRequestsResponse([]);
  if (method === "POST" && path.endsWith("/connect")) {
    await connectHeld;
    const id = decodeURIComponent(path.split("/").at(-2) ?? "");
    return startResponse({ authorizationUrl: `https://sign-in.example/${id}` });
  }
  if (path.endsWith("/confirm"))
    return Response.json({ connected: path.includes("gmail") });
  if (path === MY_CONNECTIONS_PATH)
    return connectionPage([
      // Notion's grant was withdrawn at Notion: the row stands over a revoked grant.
      { serverId: "notion", revoked: true, scope: "read" },
      {
        serverId: gmail.id,
        verified: true,
        verifiedAt: "2026-11-01T09:00:00.000Z",
        probe: null,
      },
    ]);
  const apps = answerAppsApi(url, init, {
    servers: [notion, gmail],
    catalogue: [notionEntry],
    composioConfigured: true,
    provider: "composio",
    botsMayCallBack: true,
    redirectUri: "https://openbot.example/callback",
  });
  if (apps) return apps;
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
      page.__events.push("tab closed");
    },
    focus: () => {},
  };
  return tab as unknown as Window;
}) as typeof window.open;

const SO_FAR: Message[] = [
  {
    id: "asked",
    role: "user",
    content: "What did Dana say about the launch date in her last email?",
  },
  {
    id: "called",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: "mcp__composio-gmail__GMAIL_FETCH_EMAILS",
          arguments: JSON.stringify({ query: "from:dana launch" }),
        },
      },
    ],
  },
  {
    id: "answered",
    role: "tool",
    toolCallId: "call-1",
    // The refusal a call answers when the vendor no longer holds the account, as the server writes it.
    content: `${REFUSAL_MARKER} ${connectAppRefusal({
      serverId: gmail.id,
      title: "Gmail",
      message:
        "Your Gmail account is no longer connected, so this was not done. Reconnect it and ask again.",
      agentId: BOT,
      reason: "reconnect",
      at: "2026-11-20T12:00:00.000Z",
    })}`,
  },
  {
    id: "said",
    role: "assistant",
    content:
      "Your Gmail account needs reconnecting. Reconnect it and I'll find Dana's email.",
  },
];

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

const root = createRootRoute({ component: Outlet });
const authed = createRoute({
  id: "/_authed",
  getParentRoute: () => root,
  component: Outlet,
});
const shell = createRoute({
  id: "/_app",
  getParentRoute: () => authed,
  component: () => (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <Outlet />
    </div>
  ),
});
const routed = (route: unknown, path: string) =>
  (route as { update: (o: unknown) => unknown }).update({
    id: path,
    path,
    getParentRoute: () => shell,
  }) as never;
const conversation = createRoute({
  getParentRoute: () => shell,
  path: "/",
  component: () => (
    <ConversationView
      busy={false}
      channelId="channel-1"
      messages={SO_FAR}
      onStop={() => {}}
      onSubmit={async () => {}}
      pending={false}
      stoppable={false}
    />
  ),
});
const router = createRouter({
  routeTree: root.addChildren([
    authed.addChildren([
      shell.addChildren([
        conversation,
        routed(ConnectionsRoute, "/connections/"),
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
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
