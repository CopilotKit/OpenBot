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
import { AppsSections } from "@/components/bot-profile/access";
import { ConversationView } from "@/components/channels/conversation-view";
import { PageShell } from "@/components/layout/page-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentProfile } from "@/lib/agents/queries";
import type { AppAccess } from "@/lib/app-access/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { ME_PATH, meResponse } from "./accounts-api";
import {
  APPS_SETTING_PATH,
  appsSettingResponse,
  DEPLOYMENT_PATH,
} from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import {
  APP_ACCESS_REQUESTS_PATH,
  APP_SETUP_PATH,
  appAccessRequest,
  appAccessRequestResponse,
  appSetupResponse,
  botAppPath,
  botAppResponse,
  botAppsPath,
  botAppsResponse,
  botGrantsPath,
  botGrantsResponse,
} from "./bot-grants-api";
import { botPath } from "./bots-api";
import { connectionPage, MY_CONNECTIONS_PATH } from "./connections-api";
import {
  MEMBERS_PATH,
  membersResponse,
  organizationMember,
} from "./organizations-api";

/**
 * A member of a team OpenBot whose Bot can't use Gmail yet, as a page of its own for
 * name-the-admins-layout.test.tsx to bundle and load in a browser: at `/` the real conversation
 * view draws the real card from the `show_app_access` answer, and at `/bot` the Bot's Apps page
 * draws its row for Gmail. Both name the organization's admins, owners first, and after Request
 * access say who it was sent to. This page plays the server.
 *
 * `?role=admin` is an admin looking instead, and `?theme=dark` draws it dark.
 */
setCurrentOrganization("default");

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const role = params.get("role") === "admin" ? "admin" : "member";

const BOT = "assistant";
const GMAIL = "composio-gmail";

let gmail: AppAccess = appAccess({
  key: GMAIL,
  displayName: "Gmail",
  state: "not_granted",
  granted: false,
  requestKind: "grant",
  // Kept to admins: only an admin can give it, so the sentence names them in either mode.
  ownerGrants: "admin",
});

/** Five admins, so the sentence names three and counts the rest. */
const MEMBERS = [
  organizationMember("Sam Lee", "sam@northwind.test", "member"),
  organizationMember("Ines Duarte", "ines@northwind.test", "admin"),
  organizationMember("Priya Raman", "priya@northwind.test", "owner"),
  organizationMember("Morgan Reyes", "morgan@northwind.test", "admin"),
  organizationMember("Tom Avery", "tom@northwind.test", "admin"),
  organizationMember(null, "kit@northwind.test", "admin"),
];

const original = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (!path.startsWith("/api/")) return original(input, init);
  if (path === DEPLOYMENT_PATH)
    return Response.json({
      generativeUi: true,
      selfHostBanner: false,
      localEvaluation: false,
      edition: "team",
    });
  if (path === ME_PATH)
    return meResponse({ user: { id: "usr_me", role, name: "Me" } });
  // Apps locked down: naming the admins and Request access are locked down's.
  if (path === APPS_SETTING_PATH) return appsSettingResponse(true);
  if (path === MEMBERS_PATH) return membersResponse(url.toString(), MEMBERS);
  if (path === botPath(BOT))
    return Response.json({ bot: { id: BOT, name: "Personal Assistant" } });
  if (path === APP_SETUP_PATH) return appSetupResponse();
  if (method === "GET" && path === botAppPath(BOT, GMAIL))
    return botAppResponse(gmail);
  if (method === "GET" && path === botAppsPath(BOT))
    return botAppsResponse([gmail]);
  if (path.startsWith(botGrantsPath(BOT))) return botGrantsResponse({});
  if (method === "POST" && path === APP_ACCESS_REQUESTS_PATH) {
    const filed = appAccessRequest({ id: "req_gmail", agentId: BOT });
    gmail = {
      ...gmail,
      request: { id: filed.id, kind: "grant", createdAt: filed.createdAt },
    };
    return appAccessRequestResponse(filed);
  }
  if (path.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
  if (path.endsWith("/handoff"))
    return Response.json({
      handoff: {
        enabled: false,
        canGrant: false,
        reachable: [],
        grantable: false,
      },
    });
  return Response.json({ error: "Not found." }, { status: 404 });
}) as typeof fetch;

const SO_FAR: Message[] = [
  {
    id: "asked",
    role: "user",
    content: "Find the invoice Acme sent last week and file it.",
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
          arguments: JSON.stringify({ app: GMAIL }),
        },
      },
    ],
  },
  {
    id: "answered",
    role: "tool",
    toolCallId: "call-1",
    content: connectAppRefusal({
      serverId: GMAIL,
      title: "Gmail",
      message: "Personal Assistant hasn't been given Gmail.",
      agentId: BOT,
      reason: "access",
      blocked: true,
    }),
  },
  {
    id: "said",
    role: "assistant",
    content: "I need Gmail to find that invoice.",
  },
];

const AGENT: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
  id: BOT,
  name: "Personal Assistant",
  title: "Assistant",
  roleDescription: "Helps with email.",
  avatarSeed: "a",
  visibility: "public",
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
  canManage: false,
  mine: false,
};

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
const botPage = createRoute({
  getParentRoute: () => root,
  path: "/bot",
  component: () => (
    <div className="min-h-svh bg-background text-foreground">
      <PageShell title="Apps">
        <AppsSections agent={AGENT} />
      </PageShell>
    </div>
  ),
});
const appPage = createRoute({
  getParentRoute: () => root,
  path: "/connections/$key",
  component: () => null,
});
const grants = createRoute({
  getParentRoute: () => root,
  path: "/admin/plugins/$key/bots/$agentId",
  component: () => null,
});
const router = createRouter({
  routeTree: root.addChildren([conversation, botPage, appPage, grants]),
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
