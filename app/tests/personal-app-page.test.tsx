import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { PluginBotPage } from "@/components/manage/plugin-bot-page";
import { PluginPage } from "@/components/manage/plugin-page";
import { PluginToolPage } from "@/components/manage/plugin-tool-page";
import { agentKeys } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import {
  type PluginServer,
  type PluginsPage,
  pluginKeys,
} from "@/lib/plugins/queries";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const catalogueNotion = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};

const notionServer = {
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
  addedBy: "me",
  dynamicClient: true,
  authScheme: null,
  tools: [],
  withdrawn: [],
  accountMode: null,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
} as unknown as PluginServer;

function pageWith(servers: PluginServer[]): PluginsPage {
  return {
    catalogue: [catalogueNotion],
    servers,
    skills: [],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: true,
    provider: "composio",
    authorizesPerAction: false,
  } as unknown as PluginsPage;
}

/** Exa as an app added from Composio's directory: no catalogue entry, reached as each person. */
const exaServer = {
  ...notionServer,
  id: "composio-exa",
  title: "Exa",
  vendor: "Composio",
  url: "composio://exa",
  summary: "",
  provenance: "composio",
  hasCredential: false,
  dynamicClient: false,
  authScheme: "API_KEY",
  accountMode: "personal",
} as unknown as PluginServer;

/**
 * Every write the page sends, in order. The plugin list answers with whatever the test drew until
 * the page adds Notion, and with Notion turned on after.
 */
const writes: string[] = [];
let servers: PluginServer[] = [];
/** Your accounts, as `/api/plugins/connections` answers. A disconnect empties it. */
let connections: unknown[] = [];
const originalFetch = global.fetch;
beforeEach(() => {
  writes.length = 0;
  connections = [];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input).split("?")[0];
      if (init?.method && init.method !== "GET") {
        writes.push(`${init.method} ${path}`);
        if (path === "/api/plugins/servers") servers = [notionServer];
        if (path.endsWith("/connect"))
          return Response.json({ connected: true });
        if (init.method === "DELETE" && path.endsWith("/connection"))
          connections = [];
        else if (init.method === "DELETE")
          servers = servers.filter(
            (server) => path !== `/api/plugins/servers/${server.id}`,
          );
        return Response.json({ ok: true });
      }
      if (path === "/api/plugins") return Response.json(pageWith(servers));
      if (path === "/api/plugins/connections")
        return Response.json({ connections });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw(
  edition: "team" | "personal",
  drawn: PluginServer[],
  pluginKey = "notion",
  page: () => React.ReactNode = () => <PluginPage pluginKey={pluginKey} />,
  bots: unknown[] = [],
) {
  servers = drawn;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  });
  client.setQueryData(pluginKeys.page(), pageWith(drawn));
  client.setQueryData(pluginKeys.connections(), { connections: [] });
  client.setQueryData(agentKeys.list(false), bots);
  client.setQueryData(agentKeys.list(true), bots);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: page,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("an app's page in the personal edition", () => {
  test("offers Connect for an app that isn't added, instead of a switch for everybody", async () => {
    const view = draw("personal", []);
    expect(
      await view.findByRole("button", { name: "Connect Notion" }),
    ).toBeTruthy();
    expect(view.queryByText("Enable for this deployment")).toBeNull();
  });

  test("turns the app on and starts connecting your account in one press", async () => {
    const view = draw("personal", []);
    const user = userEvent.setup({ document });
    await user.click(
      await view.findByRole("button", { name: "Connect Notion" }),
    );
    await waitFor(() =>
      expect(writes).toEqual([
        "POST /api/plugins/servers",
        "POST /api/plugins/servers/notion/connect",
      ]),
    );
  });

  test("has no choices that only matter with other people", async () => {
    const view = draw("personal", [notionServer]);
    await view.findByText("Your account");
    expect(view.queryByText("Bot owners can give it to their Bots")).toBeNull();
    expect(view.queryByText("Whose account")).toBeNull();
    expect(view.container.textContent).not.toContain("this deployment");
  });

  test("lists the app's tools for every Bot, with nothing to give one at a time", async () => {
    const withTools = {
      ...notionServer,
      tools: [
        {
          ref: "notion/search",
          name: "search",
          description: "Search your pages.",
          effect: "read",
          grantedTo: [],
        },
      ],
    } as unknown as PluginServer;
    const view = draw("personal", [withTools]);
    expect(await view.findByText("Search")).toBeTruthy();
    // The setting by its name in Settings > Approvals; it was once "Ask before acting", named nowhere.
    expect(view.getByText(/Every Bot can use these/).textContent).toContain(
      "While Extra vigilant is on,",
    );
    expect(view.container.textContent).not.toContain("Ask before acting");
    expect(view.queryByRole("button", { name: "Grant tools…" })).toBeNull();
    expect(view.queryByText("By Bot")).toBeNull();
    expect(view.queryByRole("link", { name: /search/ })).toBeNull();
  });

  test("goes back to Connections", async () => {
    const view = draw("personal", [notionServer]);
    const back = await view.findByRole("button", { name: /Connections/ });
    expect(back.getAttribute("href")).toBe("/connections");
  });
});

/**
 * Gmail as Browse apps adds it, with tools and descriptions as Composio lists them on main
 * 0c140734: the Windows run showed the stored names and a documents sentence on this page.
 */
const gmailTool = (
  name: string,
  effect: "read" | "write",
  description: string,
) => ({
  serverId: "composio-gmail",
  name,
  ref: `composio-gmail/${name}`,
  description,
  inputSchema: {},
  effect,
  destructive: false,
  grantedTo: [],
});
const gmailServer = {
  ...notionServer,
  id: "composio-gmail",
  title: "Gmail",
  vendor: "Composio",
  url: "composio://gmail",
  summary: "",
  provenance: "composio",
  hasCredential: false,
  dynamicClient: false,
  authScheme: "OAUTH2",
  accountMode: "personal",
  sharedOnly: false,
  tools: [
    gmailTool(
      "GMAIL_ADD_LABEL_TO_EMAIL",
      "write",
      "Adds and/or removes specified Gmail labels for a message; ensure `message_id` and all `label_ids` are valid (use 'listLabels' for custom label IDs).",
    ),
    gmailTool(
      "GMAIL_GET_DRAFT",
      "read",
      "Retrieves a single Gmail draft by its ID. Use this to fetch and inspect draft content before sending via GMAIL_SEND_DRAFT. The format parameter controls the level of detail returned.",
    ),
    gmailTool(
      "GMAIL_GET_PROFILE",
      "read",
      "Retrieves Gmail profile information (email address, aggregate messagesTotal/threadsTotal, historyId) for a user. messagesTotal counts individual emails; threadsTotal counts conversations.",
    ),
    gmailTool(
      "GMAIL_LIST_MESSAGES",
      "read",
      "DEPRECATED: Use GMAIL_FETCH_EMAILS instead. Lists the messages in the user's mailbox.",
    ),
    gmailTool(
      "GMAIL_SEND_EMAIL",
      "write",
      "Sends an email immediately through Gmail to specified To, Cc, or Bcc recipients, with a subject or body and optional attachments. Supports plain text or HTML and may append the configured Gmail signature; attachments are limited to 20 MiB in total before encoding.",
    ),
  ],
} as unknown as PluginServer;

describe("Gmail's page in the personal edition", () => {
  test("names each tool in words, with what it does and whether it changes things", async () => {
    const view = draw("personal", [gmailServer], "composio-gmail");
    const add = await view.findByText("Add label to email");
    const row = add.closest("[data-slot=item]") as HTMLElement;
    expect(row.textContent).toContain(
      "Adds and/or removes specified Gmail labels for a message.",
    );
    expect(row.textContent).toContain("changes things");
    expect(view.getByText("Send email")).toBeTruthy();
    expect(view.getByText("Get draft")).toBeTruthy();
    expect(view.getByText("Retrieves a single Gmail draft.")).toBeTruthy();
    // A first sentence that names an id is left out, and the row keeps its words and its marker.
    const profile = view
      .getByText("Get profile")
      .closest("[data-slot=item]") as HTMLElement;
    expect(profile.textContent).toBe("Get profilereads");
    expect(view.getAllByText("changes things")).toHaveLength(2);
    expect(view.getAllByText("reads")).toHaveLength(3);

    const text = view.container.textContent ?? "";
    expect(text).not.toContain("GMAIL_");
    expect(text).not.toMatch(/`|\w_\w|listLabels|historyId/);
  });

  test("says what connecting Gmail does, not a documents app's sentence", async () => {
    const view = draw("personal", [gmailServer], "composio-gmail");
    expect(
      await view.findByText(
        "Connect your Gmail account so your Bots can use it.",
      ),
    ).toBeTruthy();
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("documents");
    expect(text).not.toContain("connector");
    expect(text).not.toContain("Composio");
  });

  test("team Admin keeps the stored names, and names Gmail's account", async () => {
    const view = draw("team", [gmailServer], "composio-gmail");
    expect(await view.findByText("GMAIL_ADD_LABEL_TO_EMAIL")).toBeTruthy();
    expect(
      view.getByText(
        /Setup is complete without it, and it reaches only your own Gmail account\./,
      ),
    ).toBeTruthy();
    expect(view.container.textContent).not.toContain("documents");
  });
});

/**
 * Gmail's tools whose first sentence read as text for a model: "Tool to", a word in capitals, and how
 * the tool finds a thing by its ID. Composio's own descriptions, as main bdb3a3df lists them.
 */
const gmailToolsForModels = {
  ...gmailServer,
  tools: [
    gmailTool(
      "GMAIL_CREATE_FILTER",
      "write",
      "Tool to create a new Gmail filter with specified criteria and actions. Use when the user wants to automatically organize incoming messages based on sender, subject, size, or other criteria. Note: you can only create a maximum of 1,000 filters per account.",
    ),
    gmailTool(
      "GMAIL_DELETE_FILTER",
      "write",
      "Tool to permanently delete a Gmail filter by its ID. Use when you need to remove an existing email filtering rule.",
    ),
    gmailTool(
      "GMAIL_DELETE_THREAD",
      "write",
      "Tool to immediately and permanently delete a specified thread and all its messages. This operation cannot be undone. Use threads.trash instead for reversible deletion.",
    ),
    gmailTool(
      "GMAIL_DELETE_LABEL",
      "write",
      "Permanently DELETES a user-created Gmail label from the account (not from a message). WARNING: This action DELETES the label definition itself, removing it from all messages. System labels (INBOX, SENT, UNREAD, etc.) cannot be deleted. To add/remove labels from specific messages, use GMAIL_ADD_LABEL_TO_EMAIL action instead.",
    ),
    gmailTool(
      "GMAIL_BATCH_DELETE_MESSAGES",
      "write",
      "Permanently deletes multiple Gmail messages by ID, bypassing Trash. A successful request does not confirm individual messages existed or were deleted.",
    ),
    gmailTool(
      "GMAIL_INSERT_MESSAGE",
      "write",
      "Tool to insert a message into the user's mailbox similar to IMAP APPEND. Use when you need to add an email directly to a mailbox bypassing most scanning and classification. This does not send a message.",
    ),
  ],
} as unknown as PluginServer;

test("Gmail's page says what each tool does as a person would, not as its description tells a model", async () => {
  const view = draw("personal", [gmailToolsForModels], "composio-gmail");
  const said = (name: string) =>
    (view.getByText(name).closest("[data-slot=item]") as HTMLElement)
      .textContent;
  await view.findByText("Create filter");
  expect(said("Create filter")).toContain(
    "Creates a new Gmail filter with specified criteria and actions.",
  );
  expect(said("Delete filter")).toContain(
    "Permanently deletes a Gmail filter.",
  );
  expect(said("Delete thread")).toContain(
    "Immediately and permanently deletes a specified thread and all its messages.",
  );
  expect(said("Delete label")).toContain(
    "Permanently deletes a user-created Gmail label from the account (not from a message).",
  );
  expect(said("Batch delete messages")).toContain(
    "Permanently deletes multiple Gmail messages, bypassing Trash.",
  );
  // A name written in capitals is not a word said loudly.
  expect(said("Insert message")).toContain(
    "Inserts a message into the user's mailbox similar to IMAP append.",
  );
  const text = view.container.textContent ?? "";
  expect(text).not.toMatch(/Tool to|DELETES|by (its )?ID/);
  expect(view.getAllByText("changes things")).toHaveLength(6);
});

test("team Admin keeps the descriptions as the app wrote them", async () => {
  const view = draw("team", [gmailToolsForModels], "composio-gmail");
  expect(
    await view.findByText(
      /^Tool to permanently delete a Gmail filter by its ID\./,
    ),
  ).toBeTruthy();
});

/**
 * An app's page with Connections behind it, as `/connections/$key` sits under `/connections`, so
 * where the page sends somebody is where they land.
 */
function drawAtConnections(drawn: PluginServer[], pluginKey: string) {
  servers = drawn;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: true,
    edition: "personal",
  });
  client.setQueryData(pluginKeys.page(), pageWith(drawn));
  client.setQueryData(pluginKeys.connections(), { connections });
  client.setQueryData(agentKeys.list(false), []);
  client.setQueryData(agentKeys.list(true), []);
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/connections",
    component: () => <p>The Connections list</p>,
  });
  const app = createRoute({
    getParentRoute: () => root,
    path: "/connections/$key",
    component: () => <PluginPage pluginKey={pluginKey} />,
  });
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: [`/connections/${pluginKey}`],
    }),
    routeTree: root.addChildren([list, app]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

describe("turning an app off from its own page", () => {
  /*
   * Exa added from Composio's directory has no catalogue entry, so once it was off the page had
   * nothing to draw and said "Not an app. There is no app with that name." Connections lists such an
   * app only while it is on, and adds it again from the directory.
   */
  test("an app added from the directory goes back to Connections", async () => {
    const { view, router } = drawAtConnections([exaServer], "composio-exa");
    const user = userEvent.setup({ document });
    await user.click(
      await view.findByRole("switch", { name: "Turn Exa on or off" }),
    );
    expect(await view.findByText("The Connections list")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/connections");
    expect(writes.filter((write) => write.startsWith("DELETE"))).toEqual([
      "DELETE /api/plugins/servers/composio-exa",
    ]);
    expect(view.queryByText("Not an app")).toBeNull();
  });

  test("a catalogue app stays on its page, off, with Connect to turn it back on", async () => {
    const { view, router } = drawAtConnections([notionServer], "notion");
    const user = userEvent.setup({ document });
    await user.click(
      await view.findByRole("switch", { name: "Turn Notion on or off" }),
    );
    expect(
      await view.findByRole("button", { name: "Connect Notion" }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe("/connections/notion");
    expect(view.queryByText("Not an app")).toBeNull();
  });

  test("disconnecting your account leaves the app on, on its page, with Connect", async () => {
    connections = [
      {
        serverId: "composio-exa",
        holder: "person",
        scope: "",
        connectedAt: "2026-11-07T00:00:00.000Z",
        verified: true,
        verifiedAt: "2026-11-07T00:00:00.000Z",
      },
    ];
    const { view, router } = drawAtConnections([exaServer], "composio-exa");
    const user = userEvent.setup({ document });
    await user.click(await view.findByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(writes.filter((write) => write.startsWith("DELETE"))).toEqual([
        "DELETE /api/plugins/servers/composio-exa/connection",
      ]),
    );
    expect(await view.findByRole("button", { name: "Connect" })).toBeTruthy();
    expect(
      view.getByRole("switch", { name: "Turn Exa on or off" }),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe("/connections/composio-exa");
  });
});

test("the team edition's page is unchanged", async () => {
  const view = draw("team", [notionServer]);
  expect(await view.findByText("Enable for this deployment")).toBeTruthy();
  expect(view.getByText("Bot owners can give it to their Bots")).toBeTruthy();
});

test("Routines' tool and per-Bot pages say always on, rather than offer a switch the server refuses", async () => {
  const routines = {
    ...notionServer,
    id: "routines",
    title: "Routines",
    url: "builtin://routines/",
    dynamicClient: false,
    tools: [
      {
        name: "schedule",
        ref: "routines/schedule",
        description: "Schedule work.",
        serverId: "routines",
        inputSchema: {},
        effect: "write",
        destructive: false,
        grantedTo: ["bot-1"],
      },
    ],
  } as unknown as PluginServer;
  const bots = [{ id: "bot-1", name: "Expenses", hidden: false }];
  for (const page of [
    () => <PluginToolPage pluginKey="routines" toolName="schedule" />,
    () => <PluginBotPage agentId="bot-1" pluginKey="routines" />,
  ]) {
    const view = draw("team", [routines], "routines", page, bots);
    expect(await view.findByText("Always on")).toBeTruthy();
    expect(view.queryByRole("switch")).toBeNull();
    cleanup();
  }
});

test("Routines is always on in the team edition too, with no switch to turn it off", async () => {
  const routines = {
    ...notionServer,
    id: "routines",
    title: "Routines",
    url: "builtin://routines/",
    dynamicClient: false,
  } as PluginServer;
  const view = draw("team", [routines], "routines");
  expect(await view.findByText("Always on")).toBeTruthy();
  expect(view.queryByText("Enable for this deployment")).toBeNull();
  expect(view.queryByRole("switch", { name: /Routines/ })).toBeNull();
});

/** Gmail's tools whose names read as their stored ids did, as Composio lists them on main cb764bf6. */
const gmailNamedLikeIds = {
  ...gmailServer,
  tools: [
    gmailTool(
      "GMAIL_WHO_AM_I",
      "read",
      "Return the identity (email, name) of the connected Gmail account.",
    ),
    gmailTool(
      "GMAIL_UPDATE_IMAP_SETTINGS",
      "write",
      "Tool to update IMAP settings for a Gmail account. Use when you need to modify IMAP configuration such as enabling/disabling IMAP, setting auto-expunge behavior, or configuring folder size limits.",
    ),
    gmailTool(
      "GMAIL_UPDATE_POP_SETTINGS",
      "write",
      "Tool to update POP settings for a Gmail account. Use when you need to configure POP access window or message disposition behavior.",
    ),
    gmailTool(
      "GMAIL_SETTINGS_GET_IMAP",
      "read",
      "Retrieves the IMAP settings for a Gmail user account, including whether IMAP is enabled, auto-expunge behavior, expunge behavior, and maximum folder size.",
    ),
    gmailTool(
      "GMAIL_SETTINGS_GET_POP",
      "read",
      "Tool to retrieve POP settings for a Gmail account. Use when you need to check the current POP configuration including access window and message disposition.",
    ),
    gmailTool(
      "GMAIL_SETTINGS_SEND_AS_GET",
      "read",
      "Tool to retrieve a specific send-as alias configuration for a Gmail user. Use when you need to get details about a send-as email address including display name, signature, SMTP settings, and verification status.",
    ),
    gmailTool(
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "read",
      "Fetches a Gmail message by its message ID in the requested format and returns formatted message details. Available fields depend on the format.",
    ),
    gmailTool(
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "read",
      "Retrieves messages from an accessible Gmail thread by thread ID, returning thread details and a messages array.",
    ),
    gmailTool(
      "GMAIL_LIST_CSE_IDENTITIES",
      "read",
      "Lists a page of client-side encrypted identities and their key-pair associations. A response indicating that CSE is not enabled is returned as an empty list.",
    ),
    gmailTool(
      "GMAIL_LIST_CSE_KEYPAIRS",
      "read",
      "Lists a page of client-side encryption key pairs, including public keys and enablement states.",
    ),
    gmailTool(
      "GMAIL_STOP_WATCH",
      "write",
      "Tool to stop receiving push notifications for a Gmail mailbox. Use when you need to disable watch notifications previously set up via the watch endpoint.",
    ),
    gmailTool(
      "GMAIL_UNTRASH_MESSAGE",
      "write",
      "Tool to remove a message from trash in Gmail. Use when you need to restore a previously trashed email message.",
    ),
    gmailTool(
      "GMAIL_UPDATE_CONTACT",
      "write",
      "Replace selected fields on an existing saved Google contact.",
    ),
  ],
} as unknown as PluginServer;

test("Gmail's page names each tool as a person would, and says what each one does", async () => {
  const view = draw("personal", [gmailNamedLikeIds], "composio-gmail");
  await view.findByText("Who am I");
  const names = [...view.container.querySelectorAll("[data-slot=item-title]")]
    .map((title) => title.textContent)
    .slice(-13);
  // In the order of the names it shows, not the stored names' order: "Get IMAP settings" under G,
  // where `GMAIL_SETTINGS_GET_IMAP` put it under S.
  expect(names).toEqual([
    "Fetch message",
    "Fetch thread messages",
    "Get IMAP settings",
    "Get POP settings",
    "Get send-as settings",
    "List CSE identities",
    "List CSE keypairs",
    "Stop watching",
    "Untrash message",
    "Update contact",
    "Update IMAP settings",
    "Update POP settings",
    "Who am I",
  ]);
  const said = (name: string) =>
    (view.getByText(name).closest("[data-slot=item]") as HTMLElement)
      .textContent;
  // Every sentence says what the tool does, the way most of them already do.
  expect(said("Who am I")).toContain(
    "Returns the identity (email, name) of the connected Gmail account.",
  );
  expect(said("Update IMAP settings")).toContain(
    "Updates IMAP settings for a Gmail account.",
  );
  expect(said("Get send-as settings")).toContain(
    "Retrieves a specific send-as alias configuration for a Gmail user.",
  );
  expect(said("Stop watching")).toContain(
    "Stops receiving push notifications for a Gmail mailbox.",
  );
  expect(said("Untrash message")).toContain(
    "Removes a message from trash in Gmail.",
  );
  expect(said("Update contact")).toContain(
    "Replaces selected fields on an existing saved Google contact.",
  );
});
