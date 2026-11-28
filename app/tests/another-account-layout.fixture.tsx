import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  anotherAccountAnswer,
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
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import { answerAppsApi } from "./apps-api";
import {
  APP_ACCESS_REQUESTS_PATH,
  appAccessRequestsResponse,
  botAppPath,
  botAppResponse,
} from "./bot-grants-api";
import { botPath } from "./bots-api";
import {
  accountsPage,
  connectionResponse,
  myAccountPath,
  myConnectionPath,
  startResponse,
} from "./connections-api";

/**
 * A conversation in which the person, whose work Gmail is connected, asks to connect their personal
 * email as well, and the Bot answered with the card for one more account. A page of its own for
 * another-account-layout.test.tsx to bundle and load in a browser: the real conversation view draws
 * the real card from the `show_app_access` answer, with this page playing the server and the app's
 * sign-in.
 *
 * Connect's press claims a tab (recorded, not opened); the sign-in in that tab is taken to finish at
 * once, so the next read of the person's accounts lists the second one. What the page sends is kept
 * in order on `window.__events`: each write, each tab claimed and where it was sent.
 */
type Page = Window & { __events: string[] };
const page = window as unknown as Page;
page.__events = [];
setCurrentOrganization("default");

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");

const APP = "composio-gmail";
const BOT = "assistant";
const WORK = {
  id: "00000000-0000-4000-8000-000000000001",
  identity: "sam.rivera@work.example",
  label: "sam.rivera@work.example",
  isDefault: true,
  connectedAt: "2026-11-01T09:00:00.000Z",
};
const PERSONAL = {
  id: "00000000-0000-4000-8000-000000000002",
  identity: "sam.rivera@home.example",
  label: "sam.rivera@home.example",
  isDefault: false,
  connectedAt: "2026-11-25T09:00:00.000Z",
};
let accounts = [WORK];
let signedIn = false;

const original = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (!path.startsWith("/api/")) return original(input, init);
  if (method !== "GET")
    page.__events.push(
      `${method} ${path}${init?.body ? ` ${String(init.body)}` : ""}`,
    );
  if (path === DEPLOYMENT_PATH)
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: true,
      edition: "personal",
    });
  if (path === ME_PATH)
    return meResponse({ user: { id: "usr_me", role: "admin", name: "Me" } });
  if (path === botPath(BOT))
    return Response.json({ bot: { id: BOT, name: "Personal Assistant" } });
  if (path === botAppPath(BOT, APP))
    return botAppResponse(
      appAccess({ key: APP, displayName: "Gmail", connect: "oauth" }),
    );
  if (path === myConnectionPath(APP, "connect")) {
    signedIn = true;
    return startResponse({ authorizationUrl: "https://gmail.test/consent" });
  }
  if (path === myConnectionPath(APP, "accounts")) {
    if (signedIn && accounts.length === 1) accounts = [WORK, PERSONAL];
    return accountsPage(accounts);
  }
  if (path === myAccountPath(APP, PERSONAL.id, "make-default")) {
    accounts = accounts.map((account) => ({
      ...account,
      isDefault: account.id === PERSONAL.id,
    }));
    return new Response(null, { status: 204 });
  }
  if (path === myConnectionPath(APP))
    return connectionResponse({ serverId: APP, canAddAccount: true });
  if (path === APP_ACCESS_REQUESTS_PATH) return appAccessRequestsResponse([]);
  const apps = answerAppsApi(input, init, {
    servers: [],
    catalogue: [],
    composioConfigured: true,
    provider: "composio",
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
  {
    id: "asked",
    role: "user",
    content: "Can I connect you to my personal email as well?",
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
          name: SHOW_APP_ACCESS_TOOL,
          arguments: JSON.stringify({ app: "Gmail", anotherAccount: true }),
        },
      },
    ],
  },
  {
    id: "answered",
    role: "tool",
    toolCallId: "call-1",
    content: anotherAccountAnswer({
      serverId: APP,
      title: "Gmail",
      agentId: BOT,
      held: 1,
      message:
        "The card in front of the person offers Connect another account. Say so in one sentence.",
    }),
  },
  {
    id: "said",
    role: "assistant",
    content:
      "Yes. Press Connect another account and sign in with your personal Gmail.",
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
