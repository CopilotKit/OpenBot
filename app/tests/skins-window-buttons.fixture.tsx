import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { PageShell } from "@/components/layout/page-shell";
import { SKINS } from "@/skins/registry";
import type { SkinId } from "@/skins/types";
import { ME_PATH, meBody, PREFERENCES_PATH } from "./accounts-api";
import { answerBotsList } from "./bots-api";

/**
 * A skin's frame around a page, as `_authed/_app` draws it, as a page of its own for
 * skins-window-buttons.test.tsx to bundle and load in Chromium. OpenBot's API is a fake that
 * answers in the shapes the real endpoints return, and the live socket never connects.
 *
 * `?skin=<id>&path=<path>` picks the skin and the page the frame opens on. `&attention=dot` gives
 * one Bot an unread message, so the Bots badge is a dot, and `&attention=<n>` gives it n things
 * waiting on the person, so the badge is a count.
 */
const params = new URLSearchParams(location.search);
const skinId = (params.get("skin") ?? "openduet") as SkinId;
const path = params.get("path") ?? "/";

const now = "2026-10-27T10:00:00.000Z";

/** What the Bots badge reads: nothing waiting, an unread message, or n things waiting on you. */
function attention(asked: string | null) {
  if (!asked) return [];
  const waiting = asked === "dot" ? 0 : Number(asked);
  return [
    {
      agentId: "b-1",
      name: "Inbox Bot",
      questions: 0,
      approvals: 0,
      handoffs: 0,
      unread: asked === "dot" ? 1 : 0,
      paused: false,
      notify: "all",
      items: 0,
      tasks: { needsInput: 0, ready: waiting, failed: 0 },
    },
  ];
}

function channel(id: string, agentIds: string[], summary: string) {
  return {
    id,
    name: agentIds.length > 1 ? "Ops group" : "Inbox Bot",
    agentIds,
    threadId: `t-${id}`,
    active: true,
    lastMessageAt: now,
    summary,
    lastMessage: summary,
    lastMessageAgentId: null,
    createdAt: now,
    pinned: false,
    lastReadAt: now,
  };
}

const bodies: Record<string, unknown> = {
  [ME_PATH]: meBody({
    user: {
      id: "u-1",
      name: "Pat Example",
      email: "pat@example.com",
      role: "admin",
      onboarding: null,
    },
  }),
  "/api/capabilities": { transcription: true },
  [PREFERENCES_PATH]: {
    messageListEmphasis: "thread",
    selfHostBannerDismissed: true,
  },
  "/api/channels": {
    channels: [
      channel("c-1", ["b-1"], "Renewal for the studio policy"),
      channel("g-1", ["b-1", "b-2"], "Kiln repair plan"),
    ],
    nextCursor: null,
  },
  "/api/bots/attention": {
    bots: attention(params.get("attention")),
    lastPingId: null,
  },
};

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.href);
  const bots = answerBotsList(url, init, {
    visible: [
      { id: "b-1", name: "Inbox Bot" },
      { id: "b-2", name: "Ops Bot" },
    ],
  });
  if (bots) return bots;
  if (url.pathname in bodies) return Response.json(bodies[url.pathname]);
  return Response.json({ error: "not served" }, { status: 404 });
}) as typeof fetch;

/** The frame keeps OpenBot's live socket open; here it never connects. */
class QuietSocket {
  onopen: unknown = null;
  onclose: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  readyState = 0;
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}
window.WebSocket = QuietSocket as unknown as typeof WebSocket;

/*
 * `?update=1`: the desktop app offers a new version, as the IPC Tauri injects
 * (`__TAURI_INTERNALS__`) answers it, so the update notice is drawn across the top.
 */
if (params.get("update") === "1")
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
    {
      invoke: async (command: string) => {
        if (command === "plugin:openbot-desktop|update_offer")
          return {
            version: "1.0.3",
            current: "1.0.2",
            installing: null,
            updatesItself: true,
            ready: { state: "ready" },
          };
        throw `command ${command} not found`;
      },
      transformCallback: () => 0,
    };

const { Frame, screens } = SKINS[skinId];
const rootRoute = createRootRoute({
  component: () =>
    Frame ? (
      <Frame>
        <Outlet />
      </Frame>
    ) : (
      <Outlet />
    ),
});
const page = (routePath: string, body: () => React.ReactNode) =>
  createRoute({
    path: routePath,
    getParentRoute: () => rootRoute,
    component: body,
  });
const screenRoute = createRoute({
  path: "/s/$screen",
  getParentRoute: () => rootRoute,
  component: function SkinScreen() {
    const { screen } = screenRoute.useParams();
    const Screen = screens?.[screen];
    return Screen ? <Screen /> : null;
  },
});
const router = createRouter({
  routeTree: rootRoute.addChildren([
    page("/", () => <h1 data-page="">Start a conversation</h1>),
    page("/bots", () => (
      <PageShell
        backButton={{ label: "Home", linkProps: { to: "/" } }}
        description="Your Bots and the ones shared with you."
        title="Bots"
      >
        <p data-page="">The roster</p>
      </PageShell>
    )),
    page("/channel/$channelId", () => <p data-page="">A conversation</p>),
    screenRoute,
  ]),
  history: createMemoryHistory({ initialEntries: [path] }),
});
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
