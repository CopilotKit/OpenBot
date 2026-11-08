import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  CONNECT_APP_MARKER,
  connectAppRefusal,
} from "@openbot/shared/connect-prompt";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { PluginPage } from "@/components/manage/plugin-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  directoryDescriptions,
  moreAppsRow,
} from "@/lib/plugins/provider-vocabulary";
import {
  type PluginConnection,
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { settleReactWork } from "./settle-react-work";

/*
 * An app's page in the personal edition is read by the one person running OpenBot on their own
 * computer. It said team things there: "Each person connects their own account through OpenBot",
 * "This deployment holds one key for every app like this", "a Bot sees only what that person can
 * see", "There is no token to paste". This draws the real page and its connect card in both
 * editions: the personal one speaks to you, and the team one keeps its words exactly.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

/** What the server answers for the page being drawn, should anything ask again. */
let served: { page: PluginsPage; connections: PluginConnection[] } | null =
  null;

const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input).split("?")[0] ?? "";
      if (served && path === "/api/plugins") return Response.json(served.page);
      if (served && path === "/api/plugins/connections")
        return Response.json({ connections: served.connections });
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterAll(() => {
  global.fetch = originalFetch;
});

const TEAM_WORDS =
  /each person|deployment|admin|token to paste|whoever|that person|everybody/i;

function brokered(authScheme: string): PluginServer {
  return {
    authScheme,
    id: "gmail",
    title: "Gmail",
    vendor: "Google",
    url: "https://example.invalid",
    summary: "Mail.",
    docsUrl: "",
    provenance: "composio",
    hasCredential: false,
    toolsRefreshedAt: null,
    lastError: null,
    addedBy: null,
    dynamicClient: false,
    accountMode: null,
    sharedVendorConnected: false,
    ownerGrants: "any",
    ownerGrantsChosen: null,
    tools: [],
    withdrawn: [],
  } as unknown as PluginServer;
}

const notion = {
  ...brokered("OAUTH2"),
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  provenance: "first-party",
  authScheme: null,
  hasCredential: true,
  dynamicClient: true,
} as unknown as PluginServer;

/** Notion's catalogue entry, which is what says it is reached as you through an OAuth client. */
const notionEntry = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};

const connectedGmail = {
  serverId: "gmail",
  scope: "",
  connectedAt: "2026-11-07T11:00:00Z",
  holder: "person",
  verified: true,
  verifiedAt: "2026-11-07T11:00:00Z",
} as unknown as PluginConnection;

function draw(input: {
  edition: "team" | "personal";
  server: PluginServer;
  configured?: boolean;
  connections?: PluginConnection[];
  catalogue?: unknown[];
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: input.edition === "personal",
    edition: input.edition,
  });
  served = {
    page: {
      catalogue: input.catalogue ?? [],
      servers: [input.server],
      skills: [],
      botsMayCallBack: true,
      redirectUri: "https://openbot.example/callback",
      composioConfigured: input.configured ?? true,
      authorizesPerAction: false,
      provider: "composio",
    } as unknown as PluginsPage,
    connections: input.connections ?? [],
  };
  client.setQueryData(pluginKeys.page(), served.page);
  client.setQueryData(pluginKeys.connections(), {
    connections: served.connections,
  });
  client.setQueryData(agentKeys.list(false), []);
  client.setQueryData(agentKeys.list(true), []);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <PluginPage pluginKey={input.server.id} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

async function pageText(view: ReturnType<typeof draw>): Promise<string> {
  await view.findByText("Connection");
  return view.container.textContent ?? "";
}

test("a brokered app's page in personal speaks to the one person", async () => {
  const text = await pageText(
    draw({ edition: "personal", server: brokered("OAUTH2") }),
  );
  expect(text).toContain("Connect your Gmail account through OpenBot.");
  expect(text).toContain(
    "You sign in to Gmail in your browser. OpenBot never sees your password.",
  );
  expect(text).toContain("Connect your Gmail account so your Bots can use it.");
  expect(text).not.toMatch(TEAM_WORDS);
  expect(text).not.toMatch(/composio/i);
});

test("the connect card in personal, once connected, says your Bots use it as you", async () => {
  const text = await pageText(
    draw({
      edition: "personal",
      server: brokered("OAUTH2"),
      connections: [connectedGmail],
    }),
  );
  expect(text).toContain(
    "Signed in with Gmail. Connected. Your Bots use your Gmail as you.",
  );
  expect(text).not.toMatch(TEAM_WORDS);
});

test("an app connected with a key says so in personal, with no password promise", async () => {
  const text = await pageText(
    draw({ edition: "personal", server: brokered("API_KEY") }),
  );
  expect(text).toContain(
    "You connect with a key from your Gmail account. Your Bots use it as you.",
  );
  expect(text).not.toContain("never sees your password");
  expect(text).not.toMatch(TEAM_WORDS);
});

test("an app with no account to connect says so in personal", async () => {
  const text = await pageText(
    draw({ edition: "personal", server: brokered("NO_AUTH") }),
  );
  expect(text).toContain("Gmail works through OpenBot without an account.");
  expect(text).toContain("There's nothing to sign in to.");
  expect(text).not.toContain("Connect your Gmail account");
  expect(text).not.toMatch(TEAM_WORDS);
});

test("the connect card in personal with apps not set up points to Setup, not an admin", async () => {
  const text = await pageText(
    draw({
      edition: "personal",
      server: brokered("OAUTH2"),
      configured: false,
    }),
  );
  expect(text).toContain(
    "Connecting apps isn't set up yet, so you can't connect or disconnect this account here. Set it up in Settings under Setup.",
  );
  expect(text).not.toMatch(TEAM_WORDS);
  expect(text).not.toMatch(/composio|grant/i);
});

test("an OAuth app's page in personal speaks to the one person", async () => {
  const text = await pageText(
    draw({ edition: "personal", server: notion, catalogue: [notionEntry] }),
  );
  expect(text).toContain(
    "Connect your Notion account through OpenBot. OpenBot registers an OAuth client, and your Bots see only what you can see.",
  );
  expect(text).not.toMatch(TEAM_WORDS);
});

test("the same brokered page in team keeps every word", async () => {
  const text = await pageText(
    draw({ edition: "team", server: brokered("OAUTH2") }),
  );
  expect(text).toContain(
    "Each person connects their own account through OpenBot.",
  );
  expect(text).toContain(
    "This deployment holds one key for every app like this. Each person connects their own account, and a Bot sees only what that person can see. There is no token to paste.",
  );
  expect(text).toContain("Through OpenBot");
});

test("the team connect card keeps its words, connected and with no key", async () => {
  const connected = await pageText(
    draw({
      edition: "team",
      server: brokered("OAUTH2"),
      connections: [connectedGmail],
    }),
  );
  expect(connected).toContain(
    "Signed in with Gmail. Connected. A Bot with these tools uses your Gmail as you. Disconnecting also removes OpenBot's access to your account.",
  );
  cleanup();
  const missing = await pageText(
    draw({ edition: "team", server: brokered("OAUTH2"), configured: false }),
  );
  expect(missing).toContain(
    "Set COMPOSIO_API_KEY on this deployment. Until then, this account can't be connected or disconnected here. The app stays turned on, and its tool grants still stand.",
  );
});

test("the Browse apps tile and the directory it opens speak to you in personal, and keep their words in team", () => {
  for (const provider of ["composio", "arcade"] as const) {
    const personal = JSON.stringify([
      moreAppsRow(provider, true, "personal"),
      moreAppsRow(provider, false, "personal"),
      directoryDescriptions("personal"),
    ]);
    expect(personal).not.toMatch(TEAM_WORDS);
    expect(personal).not.toMatch(/composio|arcade|nobody here/i);
  }
  expect(moreAppsRow("composio", true, "personal").description).toBe(
    "A few hundred more apps you can connect.",
  );
  expect(moreAppsRow("composio", true).description).toBe(
    "A few hundred apps. Each person connects their own account.",
  );
  expect(directoryDescriptions()).toEqual({
    page: "Add an app to make its tools available to Bots. Each person still connects their own account before a Bot reads anything.",
    search: "Search by name. Nobody here has reviewed these apps.",
  });
});

test("the same OAuth page in team keeps its words", async () => {
  const text = await pageText(
    draw({ edition: "team", server: notion, catalogue: [notionEntry] }),
  );
  expect(text).toContain(
    "This vendor answers as whoever is asking. The deployment registers an OAuth client, and each person connects their own account. A Bot only sees what that person can see.",
  );
});

/*
 * A refresh made before the person connected leaves the refusal a Bot gets as the app's last
 * error, and that refusal opens with the marker the chat draws as a card. The page has no card to
 * draw, and showed `[connect-app]{"serverId":"notion",...}` as text under "No tools listed".
 */
const notConnectedYet = connectAppRefusal({
  serverId: "notion",
  title: "Notion",
  message:
    "You have not connected your Notion account. Connect it and ask again.",
});

test("an app's empty tools in personal point to Connect, and never show the marker", async () => {
  const text = await pageText(
    draw({
      edition: "personal",
      server: { ...notion, lastError: notConnectedYet },
      catalogue: [notionEntry],
    }),
  );
  expect(text).toContain("No tools listed");
  expect(text).toContain(
    "Connect your Notion account above to list its tools.",
  );
  expect(text).not.toContain(CONNECT_APP_MARKER);
  expect(text).not.toContain("serverId");
  expect(text).not.toMatch(TEAM_WORDS);
});

test("an app's empty tools in team keep the refusal's sentence, without the marker", async () => {
  const text = await pageText(
    draw({
      edition: "team",
      server: { ...notion, lastError: notConnectedYet },
      catalogue: [notionEntry],
    }),
  );
  expect(text).toContain(
    "You have not connected your Notion account. Connect it and ask again.",
  );
  expect(text).not.toContain(CONNECT_APP_MARKER);
  expect(text).not.toContain("serverId");
});

test("any other last error is shown as the server wrote it", async () => {
  const text = await pageText(
    draw({
      edition: "personal",
      server: { ...notion, lastError: "Notion took too long to answer." },
      catalogue: [notionEntry],
    }),
  );
  expect(text).toContain("Notion took too long to answer.");
});
