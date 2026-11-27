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
import { Route as ConnectionsAppRoute } from "@/routes/_authed/_app/connections.$key";
import { ME_PATH, meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { appAccess } from "./app-access-fixture";
import { answerAppsApi, type TodayServer } from "./apps-api";
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
 * A conversation in which a Bot asked for Fireflies, which nobody has turned on, as a page of its
 * own for one-press-connect-layout.test.tsx to bundle and load in a browser. The real conversation
 * view draws the real card from the `show_app_access` answer, and the app's own route for its page
 * under Connections sits at `/connections/$key`, with this page playing the server.
 *
 * `?app=fireflies|slack` is the app (Fireflies connects with a key, Slack signs in),
 * `?scheme=unknown|known` whether the app says how it connects before it is on,
 * `?edition=personal|team` who is looking (the team edition's viewer is an admin), and
 * `?theme=dark` draws it dark. What the page does is kept in order on `window.__events`: each write
 * it sends, each tab it claims ("tab claimed"), where the tab is sent ("tab to <address>"), and
 * whether it is closed ("tab closed").
 */
type Page = Window & { __events: string[] };
const page = window as unknown as Page;
page.__events = [];
setCurrentOrganization("default");

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark")
  document.documentElement.classList.add("dark");
const edition = params.get("edition") === "team" ? "team" : "personal";
const signsIn = params.get("app") === "slack";
const known = params.get("scheme") === "known";
/*
 * `?state=reconnect`: Fireflies is on and connected, and its key didn't pass its check, so the card
 * says Reconnect. A Reconnect sends a new key and the key is taken (`?held=1` holds the apps list,
 * the read the app's page waits for, until `window.__release()`).
 */
const reconnecting = params.get("state") === "reconnect" && !signsIn;
const held = params.get("held") === "1";
let releaseApps: () => void = () => {};
const appsHeld = held
  ? new Promise<void>((resolve) => {
      releaseApps = resolve;
    })
  : Promise.resolve();
(window as unknown as { __release: () => void }).__release = () =>
  releaseApps();

const APP = signsIn ? "composio-slack" : "composio-fireflies";
const TITLE = signsIn ? "Slack" : "Fireflies";
const BOT = "assistant";

const before: AppAccess = appAccess({
  key: APP,
  displayName: TITLE,
  connect: known ? (signsIn ? "oauth" : "key") : null,
  state: "disabled",
  unavailable: "absent",
  granted: false,
  requestKind: "enable",
});
const after: AppAccess = appAccess({
  key: APP,
  displayName: TITLE,
  connect: signsIn ? "oauth" : "key",
  state: "not_connected",
});

/** The app as the apps list answers it once it is on: from the directory, each person's own. */
const server: TodayServer = {
  id: APP,
  title: TITLE,
  url: `composio://${signsIn ? "slack" : "fireflies"}`,
  provenance: "composio",
  authScheme: signsIn ? "OAUTH2" : "API_KEY",
  accountMode: "personal",
  ownerGrants: "any",
  tools: signsIn
    ? [
        {
          name: "SLACK_FETCH_CONVERSATION_HISTORY",
          description: "Read a channel's messages.",
          effect: "read",
          grantedTo: [BOT],
        },
      ]
    : [
        {
          name: "FIREFLIES_GET_TRANSCRIPTS",
          description: "List your meeting transcripts.",
          effect: "read",
          grantedTo: [BOT],
        },
        {
          name: "FIREFLIES_GET_TRANSCRIPT_BY_ID",
          description: "Read one meeting's transcript.",
          effect: "read",
          grantedTo: [BOT],
        },
      ],
};

const refused: AppAccess = appAccess({
  key: APP,
  displayName: TITLE,
  connect: "key",
  state: "reconnect",
  connectedAt: "2026-11-20T09:00:00.000Z",
});
/** Whether the key the person typed has been taken, which a Reconnect's form ends with. */
let rekeyed = false;

let on = reconnecting;
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
      localEvaluation: edition === "personal",
      edition,
    });
  if (path === ME_PATH)
    return meResponse({ user: { id: "usr_me", role: "admin", name: "Me" } });
  if (path === botPath(BOT))
    return Response.json({ bot: { id: BOT, name: "Personal Assistant" } });
  if (path === botAppPath(BOT, APP))
    return botAppResponse(
      reconnecting
        ? rekeyed
          ? appAccess({ ...refused, state: "ready" })
          : refused
        : on
          ? after
          : before,
    );
  if (reconnecting && path === myConnectionPath(APP, "connect")) {
    const sent =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : "";
    let values: unknown;
    try {
      values = (JSON.parse(sent || "{}") as { values?: unknown }).values;
    } catch {
      values = undefined;
    }
    if (values) {
      rekeyed = true;
      return startResponse({
        connected: true,
        verified: true,
        probe: "FIREFLIES_GET_USER",
      });
    }
  }
  if (reconnecting && path === MY_CONNECTIONS_PATH)
    return connectionPage([
      {
        serverId: APP,
        connectedAt: "2026-11-20T09:00:00.000Z",
        verified: rekeyed,
        verifiedAt: rekeyed ? "2026-11-25T09:00:00.000Z" : null,
        probe: "FIREFLIES_GET_USER",
        checkable: true,
      },
    ]);
  if (reconnecting && path.endsWith("/apps") && method === "GET")
    await appsHeld;
  if (path === `${botAppPath(BOT, APP)}/approve`) {
    on = true;
    return appAccessApprovalResponse({
      request: appAccessRequest({
        kind: "enable",
        status: "approved",
        agentId: BOT,
      }),
      enabled: true,
      granted: (server.tools ?? []).map((tool) => `${APP}/${tool.name}`),
    });
  }
  if (path === myConnectionPath(APP, "connect"))
    return signsIn
      ? startResponse({ authorizationUrl: "https://slack.test/consent" })
      : startResponse({
          fields: [
            {
              name: "api_key",
              label: "API key",
              help: "Find it in Fireflies under Integrations.",
              required: true,
              secret: true,
            },
          ],
        });
  if (path.startsWith(MY_CONNECTIONS_PATH)) return connectionPage([]);
  if (path === APP_ACCESS_REQUESTS_PATH) return appAccessRequestsResponse([]);
  const apps = answerAppsApi(input, init, {
    servers: on ? [server] : [],
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
    content: signsIn
      ? "Summarize this thread: https://acme.slack.com/archives/C024BE91L/p1700000000000100"
      : "Pull the action items from yesterday's call with the design team.",
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
    content: signsIn
      ? "I need Slack to read that thread. Connect it and I'll summarize it."
      : "I need Fireflies to read your call. Connect it and I'll pull the action items.",
  },
];

// The app's one client: the card's writes refresh it, as they do in the app.
queryClient.setDefaultOptions({ queries: { retry: false } });

/*
 * The app's own route for an app's page under Connections, mounted where the app mounts it, so the
 * page is the one each edition really draws: the whole app in the personal edition, the person's
 * own account in the team edition.
 */
const root = createRootRoute({ component: Outlet });
const authed = createRoute({
  id: "/_authed",
  getParentRoute: () => root,
  component: Outlet,
});
const app = createRoute({
  id: "/_app",
  getParentRoute: () => authed,
  component: Outlet,
});
const connections = createRoute({
  path: "/connections",
  getParentRoute: () => app,
  component: () => (
    <div className="min-h-svh bg-background text-foreground">
      <Outlet />
    </div>
  ),
});
const connectionsIndex = createRoute({
  path: "/",
  getParentRoute: () => connections,
  component: () => <p>Connections</p>,
});
const appPage = (
  ConnectionsAppRoute as unknown as { update: (options: unknown) => unknown }
).update({ id: "/$key", path: "/$key", getParentRoute: () => connections });
const conversation = createRoute({
  getParentRoute: () => app,
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
  routeTree: root.addChildren([
    authed.addChildren([
      app.addChildren([
        conversation,
        connections.addChildren([connectionsIndex, appPage as never]),
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
