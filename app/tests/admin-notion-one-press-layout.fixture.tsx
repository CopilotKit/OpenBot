import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  connectAppRefusal,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
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
import type { AppAccess } from "@/lib/app-access/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessApprovalResponse,
  appAccessRequest,
  appAccessRequestsResponse,
  botAppPath,
  botAppResponse,
} from "./bot-grants-api";
import { botPath } from "./bots-api";
import {
  connectionPage,
  MY_CONNECTIONS_PATH,
  myConnectionPath,
  startResponse,
} from "./connections-api";

/**
 * A conversation in which General Assistant was asked to connect Notion, from the directory, seen by
 * the admin of their own organization, as a page of its own for admin-notion-one-press-layout.test.tsx
 * to bundle and load in a browser. The real conversation view draws the real card from the
 * `show_app_access` answer, with this page playing the server.
 *
 * The app has listed none of its tools yet. `?server=refuses` answers the press as the server does
 * when it still can't go on: 409, "Couldn't get Notion ready for this Bot. Try again in a moment."
 * Otherwise the press turns the app on with nothing given, and once `window.__signIn()` has recorded
 * the admin's account, the next press gives its read-only tools. `?app=gmail` is Gmail in place of
 * Notion. `?on=1` starts with the app already on, `?theme=dark` draws it dark. What the page does is
 * kept in order on `window.__events`.
 */
type Page = Window & { __events: string[]; __signIn: () => void };
const page = window as unknown as Page;
page.__events = [];
setCurrentOrganization("default");

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const refuses = params.get("server") === "refuses";

const gmail = params.get("app") === "gmail";
const APP = gmail ? "composio-gmail" : "composio-notion";
const TITLE = gmail ? "Gmail" : "Notion";
const SIGN_IN = `https://backend.composio.dev/api/v3/s/${gmail ? "gmail" : "notion"}-consent`;
const BOT = "assistant";
const SIGNED_IN = "2026-11-23T23:10:00.000Z";

const notion = (overrides: Partial<AppAccess>): AppAccess =>
  appAccess({
    key: APP,
    displayName: TITLE,
    source: "directory",
    connect: "consent",
    granted: false,
    requestKind: "grant",
    ...overrides,
  });

let live: AppAccess =
  params.get("on") === "1"
    ? notion({ state: "not_granted" })
    : notion({
        state: "disabled",
        unavailable: "absent",
        requestKind: "enable",
      });

/** The admin finished Notion's sign-in in the other tab. */
page.__signIn = () => {
  live = { ...live, connectedAt: SIGNED_IN };
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
    });
  if (path === ME_PATH)
    return meResponse({ user: { id: "usr_me", role: "admin", name: "Me" } });
  if (path === botPath(BOT))
    return Response.json({ bot: { id: BOT, name: "General Assistant" } });
  if (path === botAppPath(BOT, APP)) return botAppResponse(live);
  if (path === `${botAppPath(BOT, APP)}/approve`) {
    const wasOn = live.state !== "disabled";
    const given = live.connectedAt !== null;
    if (refuses && !given) {
      // Turned on all the same, then refused for want of tools.
      live = notion({ state: "not_granted" });
      return Response.json(
        {
          detail: `Couldn't get ${TITLE} ready for this Bot. Try again in a moment.`,
        },
        { status: 409 },
      );
    }
    live = given
      ? notion({ state: "ready", granted: true, connectedAt: SIGNED_IN })
      : notion({ state: "not_granted" });
    return appAccessApprovalResponse({
      request: appAccessRequest({
        kind: wasOn ? "grant" : "enable",
        status: "approved",
        agentId: BOT,
      }),
      enabled: !wasOn,
      granted: given
        ? [gmail ? `${APP}/GMAIL_FETCH_EMAILS` : `${APP}/NOTION_SEARCH`]
        : [],
    });
  }
  if (path === myConnectionPath(APP, "connect"))
    return startResponse({ authorizationUrl: SIGN_IN });
  if (path.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
  if (path === APP_ACCESS_REQUESTS_PATH) return appAccessRequestsResponse([]);
  return Response.json({ error: "Not found." }, { status: 404 });
}) as typeof fetch;

/** The tab a sign-in claims, recorded rather than opened. */
window.open = (() => {
  page.__events.push("tab claimed");
  const tab = {
    opener: null as unknown,
    closed: false,
    location: {
      replace: (to: string) => page.__events.push(`tab to ${to}`),
    },
    close: () => {
      tab.closed = true;
      page.__events.push("tab closed");
    },
    focus: () => {},
  };
  return tab as unknown as Window;
}) as typeof window.open;

const SO_FAR: Message[] = [
  { id: "asked", role: "user", content: `Now let's connect you to ${TITLE}` },
  {
    id: "called",
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: {
          name: SHOW_APP_ACCESS_TOOL,
          arguments: JSON.stringify({ app: APP }),
        },
      },
    ],
  },
  {
    id: "answered",
    role: "tool",
    toolCallId: "call-1",
    content: connectAppRefusal({
      serverId: APP,
      title: TITLE,
      message: `${TITLE} isn't connected yet.`,
      agentId: BOT,
      reason: "access",
      blocked: true,
    }),
  },
  {
    id: "said",
    role: "assistant",
    content: `I've put a card in front of you. Give me ${TITLE} there and connect your account, and I'll check it works.`,
  },
];

queryClient.setDefaultOptions({ queries: { retry: false } });

const root = createRootRoute({ component: Outlet });
const conversation = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: () => (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <ConversationView
        busy={false}
        channelId="channel-1"
        messages={SO_FAR}
        onStop={() => {}}
        onSubmit={async () => {}}
        pending={false}
        stoppable={false}
      />
    </div>
  ),
});
const router = createRouter({
  routeTree: root.addChildren([conversation]),
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
