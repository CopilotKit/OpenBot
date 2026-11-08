import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ConnectPrompt } from "@openbot/shared/connect-prompt";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AppAccessCard } from "@/components/channels/app-access-card";
import { queryClient } from "@/query-client";
import { setEdition } from "../../server/src/edition";
import { personalPluginRoutes } from "../../server/tests/support/personal-plugin-routes";
import { settleReactWork } from "./settle-react-work";

/**
 * CONNECT ON THE CHAT CARD, FOR AN APP THAT LISTS ITS TOOLS ONLY AFTER A SIGN-IN.
 *
 * OpenBot Personal on Windows: a Bot asked to read Notion drew "Notion isn't connected yet" with
 * Connect. The press answered "Notion has no tools to give yet. Refresh its tools on its page under
 * Plugins, then try again." and no browser opened. Connect on the Connections page opened Notion's
 * sign-in the whole time.
 *
 * Notion's server lists its tools only for a person who has signed in, so turning it on saves an
 * empty list. The card's press turns it on through the same approval an admin's one press uses, and
 * that approval refused to give a Bot an app with no tools, before the sign-in that brings them.
 *
 * The real card and the server's real `/api/plugins` routes over the test database, wired as
 * OpenBot Personal wires them. Notion is the one thing faked: its registration endpoint answers in
 * the RFC 7591 shape its hosted server registers a client with, and nothing else of Notion's is
 * reached before the sign-in.
 */

const SHIM = readFileSync(
  join(import.meta.dir, "../../desktop/src-tauri/src/outside-links.js"),
  "utf8",
);

type DesktopPage = Window & {
  __openbotNavigate?: (to: string) => void;
  __openbotOutsideLinks?: boolean;
};

const suite = randomUUID().slice(0, 8);
const server = personalPluginRoutes({ suite, apps: ["notion"] });
const CLIENT_ID = `notion-client-${suite}`;

/** Every request this test's browser and server sent anywhere, as `METHOD url`. */
let sent: string[] = [];
const originalFetch = globalThis.fetch;
let originalOpen: typeof window.open;

/** Notion's registration endpoint, the only part of Notion reached before the sign-in. */
function notion(url: string, init?: RequestInit): Response {
  if (url === "https://mcp.notion.com/register" && init?.method === "POST") {
    const asked = JSON.parse(String(init.body)) as Record<string, unknown>;
    return Response.json(
      {
        client_id: CLIENT_ID,
        client_name: asked.client_name,
        redirect_uris: asked.redirect_uris,
        grant_types: asked.grant_types,
        response_types: asked.response_types,
        token_endpoint_auth_method: "none",
        registration_client_uri: `https://mcp.notion.com/register/${CLIENT_ID}`,
        client_id_issued_at: 1_778_000_000,
      },
      { status: 201 },
    );
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

function serving() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    sent.push(`${method} ${url}`);
    if (url.startsWith("/api/plugins")) return server.request(url, init);
    if (url === "/api/capabilities")
      return Response.json({ edition: "personal" });
    if (url === "/api/me")
      return Response.json({
        user: { id: server.personId, role: "admin", name: "Me" },
      });
    if (url === `/api/agents/${server.botId}`)
      return Response.json({
        agent: { id: server.botId, name: "Claude Agent SDK" },
      });
    if (url.startsWith("https://mcp.notion.com/")) return notion(url, init);
    return Response.json({});
  }) as unknown as typeof fetch;
}

/** The Desktop window: its shim installed, and every address it hands the browser recorded. */
function inTheDesktop() {
  const browser: string[] = [];
  const page = window as DesktopPage;
  page.__openbotOutsideLinks = false;
  page.__openbotNavigate = (to) => browser.push(to);
  // biome-ignore lint/security/noGlobalEval: the desktop window evaluates this shim in the page's global scope; the test must run it the same way.
  globalThis.eval(SHIM);
  return browser;
}

/** The card the `show_app_access` tool draws when a Bot is asked to read Notion. */
function drawCard() {
  const prompt: ConnectPrompt = {
    serverId: "notion",
    title: "Notion",
    message: "Notion isn't connected yet.",
    agentId: server.botId,
    reason: "access",
    blocked: true,
  };
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <AppAccessCard prompt={prompt} />,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, settings]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/channel/one" });
  originalOpen = window.open;
  setEdition("personal");
  await server.seed();
});
beforeEach(async () => {
  queryClient.clear();
  sent = [];
  await server.clear();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
  window.open = originalOpen;
  const page = window as DesktopPage;
  page.__openbotOutsideLinks = false;
  page.__openbotNavigate = undefined;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
  setEdition("team");
  await server.close();
});

test.each([
  ["nobody has turned Notion on", false],
  ["an earlier press turned Notion on and listed nothing", true],
])(
  "one press on Connect opens Notion's sign-in in the person's browser: %s",
  async (_, turnedOnAlready) => {
    if (turnedOnAlready) await server.addApp("notion");
    const browser = inTheDesktop();
    serving();
    const view = drawCard();

    fireEvent.click(
      await view.findByRole("button", { name: "Connect Notion" }),
    );

    await waitFor(() => expect(browser).toHaveLength(1), { timeout: 5_000 });
    const signIn = new URL(browser[0] ?? "");
    expect(`${signIn.origin}${signIn.pathname}`).toBe(
      "https://mcp.notion.com/authorize",
    );
    expect(signIn.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(view.queryByRole("alert")).toBeNull();
    expect(sent).toContain(
      `POST /api/plugins/for/${server.botId}/apps/notion/approve`,
    );
    expect(sent).toContain(
      "POST /api/plugins/servers/notion/connect?returnTo=settings",
    );
    await view.findByText("Finish in the tab that opened.");
    // Nothing to give yet: signing in lists Notion's tools and gives them to every Bot.
    expect(await server.botHolds("notion")).toEqual([]);
  },
  15_000,
);
