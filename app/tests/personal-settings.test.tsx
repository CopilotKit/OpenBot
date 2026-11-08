import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  isRedirect,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import { ComputersPage } from "@/components/manage/computers-page";
import { PluginToolPage } from "@/components/manage/plugin-tool-page";
import { SkillsPage } from "@/components/manage/skills-page";
import { settingsSidebarItems } from "@/components/settings/settings-sidebar";
import { type AgentProfile, agentKeys } from "@/lib/agents/queries";
import {
  type HostAccessStatus,
  hostAccessKeys,
} from "@/lib/computers/host-access";
import { type ComputerFleet, computerKeys } from "@/lib/computers/queries";
import {
  type DeploymentCapabilities,
  deploymentKeys,
} from "@/lib/deployment/queries";
import type { PluginsPage } from "@/lib/plugins/queries";
import { Route as PersonalSettingsRoute } from "@/routes/_authed/settings/_personal";
import { Route as LearningRoute } from "@/routes/_authed/settings/learning";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function capabilities(edition: "team" | "personal"): DeploymentCapabilities {
  return {
    generativeUi: true,
    selfHostBanner: false,
    localEvaluation: edition === "personal",
    edition,
  };
}

function clientFor(edition: "team" | "personal" | undefined) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (edition)
    client.setQueryData(deploymentKeys.capabilities(), capabilities(edition));
  return client;
}

const PERSONAL_ENTRIES = [
  ["Saved logins", "/settings/passwords"],
  ["Keys", "/settings/credentials"],
  ["Skills", "/settings/skills"],
  ["Computer", "/settings/computer"],
  ["Activity", "/settings/activity"],
] as const;

describe("the Settings sidebar", () => {
  test("lists what the personal edition moved out of Admin", () => {
    const items = settingsSidebarItems("personal");
    for (const [title, to] of PERSONAL_ENTRIES) {
      expect(items.find((item) => item.title === title)?.linkOptions).toEqual({
        to,
      });
    }
  });

  test("has no Apps entry, because apps are part of Connections", () => {
    const items = settingsSidebarItems("personal");
    expect(items.map((item) => item.title)).not.toContain("Apps");
    expect(
      items.some(
        (item) =>
          (item.linkOptions as { to?: string }).to === "/settings/plugins",
      ),
    ).toBe(false);
  });

  test("keeps saved logins and keys, named as on Connections", () => {
    const titles = settingsSidebarItems("personal").map((item) => item.title);
    expect(titles).not.toContain("Passwords");
    expect(titles).not.toContain("Credentials");
    expect(settingsSidebarItems("team").map((item) => item.title)).toContain(
      "Passwords",
    );
  });

  test("Learning shows in the personal edition's settings", () => {
    for (const edition of ["personal", "team"] as const) {
      expect(settingsSidebarItems(edition).map((item) => item.title)).toContain(
        "Learning",
      );
    }
    expect(LearningRoute.options.beforeLoad).toBeUndefined();
  });

  test("lists none of it in the team edition", () => {
    const titles = settingsSidebarItems("team").map((item) => item.title);
    for (const [title] of PERSONAL_ENTRIES) expect(titles).not.toContain(title);
  });
});

describe("the personal pages under Settings", () => {
  type BeforeLoad = (input: {
    context: { queryClient: QueryClient };
  }) => Promise<unknown> | unknown;
  const beforeLoad = PersonalSettingsRoute.options
    .beforeLoad as unknown as BeforeLoad;

  async function outcome(client: QueryClient) {
    try {
      await beforeLoad({ context: { queryClient: client } });
      return "open";
    } catch (thrown) {
      return isRedirect(thrown) ? thrown.options.to : thrown;
    }
  }

  test("open in the personal edition", async () => {
    expect(await outcome(clientFor("personal"))).toBe("open");
  });

  test("send the team edition back to Settings", async () => {
    expect(await outcome(clientFor("team"))).toBe("/settings");
  });

  test("send an edition that couldn't be read back to Settings", async () => {
    const originalFetch = global.fetch;
    global.fetch = Object.assign(
      async () => new Response(null, { status: 500 }),
      { preconnect: originalFetch.preconnect },
    );
    try {
      expect(await outcome(clientFor(undefined))).toBe("/settings");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("call the skills page Skills, with nothing about every Bot", async () => {
    const client = clientFor("personal");
    client.setQueryData(["plugins", "page"], {
      catalogue: [],
      servers: [],
      skills: [],
      botsMayCallBack: true,
      redirectUri: null,
      composioConfigured: false,
      authorizesPerAction: false,
    } satisfies PluginsPage);
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({ component: () => <SkillsPage /> }),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    expect(await view.findByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(view.container.textContent).not.toContain("every Bot");
  });

  test("link to each other under Settings, not Admin", async () => {
    const client = clientFor("personal");
    const page: PluginsPage = {
      catalogue: [],
      servers: [],
      skills: [],
      botsMayCallBack: true,
      redirectUri: null,
      composioConfigured: false,
      authorizesPerAction: false,
    };
    client.setQueryData(["plugins", "page"], page);
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({
        component: () => (
          <PluginToolPage pluginKey="notion" toolName="search" />
        ),
      }),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    // The page's back button: an anchor drawn as a button.
    const back = await view.findByRole("button", { name: /Plugin/ });
    expect(back.getAttribute("href")).toBe("/connections/notion");
  });
});

/*
 * The Computer page in the personal edition is one person's one computer. It used to say how to give
 * each person a computer of their own (an environment variable only a team deployment sets) and list
 * "Computers in this deployment" by whose seat each was. The person's own controls stay.
 */
describe("the Computer page", () => {
  /** What the one shared computer answers once the Personal Assistant has opened a page. */
  const fleet: ComputerFleet = {
    isolation: "shared",
    computers: [
      {
        computer: "person:dev-local-user",
        kind: "person",
        personId: "dev-local-user",
        person: { name: "dev@openbot.local", email: "dev@openbot.local" },
        botId: "personal-assistant",
        running: true,
        startedAt: "2026-11-07T04:21:42.051Z",
        egress: "network policy filter",
      },
    ],
  };
  const hostAccess: HostAccessStatus = {
    connected: false,
    grants: [],
    pending: [],
  };
  const assistant = {
    id: "personal-assistant",
    name: "Personal Assistant",
  } as AgentProfile;

  async function renderPage(
    edition: "team" | "personal",
    host: HostAccessStatus = hostAccess,
    computers: ComputerFleet = fleet,
  ) {
    const client = clientFor(edition);
    client.setDefaultOptions({
      queries: { retry: false, staleTime: Infinity },
    });
    client.setQueryData(computerKeys.fleet(), computers);
    // No Bot is hidden: a name not on the list is then a Bot that is gone.
    client.setQueryData(agentKeys.list(true), []);
    client.setQueryData(hostAccessKeys.status(), host);
    client.setQueryData(agentKeys.list(false), [assistant]);
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({ component: () => <ComputersPage /> }),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>,
    );
    await view.findByRole("heading", { name: /^Computers?$/ });
    return view;
  }

  test("in the personal edition has nothing only a team deployment can act on", async () => {
    const view = await renderPage("personal");
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("COMPUTER_SUPERVISOR_URL");
    expect(text).not.toContain("Computers in this deployment");
    expect(text).not.toContain("isolated Bot");
    expect(text).not.toContain("dev@openbot.local");
    expect(text).not.toContain("This person's profile");
    expect(text).not.toContain("network policy filter");
    expect(view.getByRole("heading", { name: "Computer" })).toBeTruthy();
  });

  test("in the personal edition keeps folders and each Bot's browser, with Stop and Reset", async () => {
    const view = await renderPage("personal");
    expect(
      view.getByRole("heading", { name: "Folders on this computer" }),
    ).toBeTruthy();
    const browsers = view.getByRole("heading", { name: "Your Bots' browsers" })
      .parentElement?.parentElement as HTMLElement;
    expect(within(browsers).getByText("Personal Assistant")).toBeTruthy();
    expect(
      within(browsers).getByRole("button", { name: "Stop browser" }),
    ).toBeTruthy();
    expect(
      within(browsers).getByRole("button", { name: "Reset" }),
    ).toBeTruthy();
  });

  /**
   * Teach a Bot's browser, as GET /api/computers/fleet lists it beside the Bots' browsers on the personal edition's one
   * computer: a seat named by the person's browser id (`person-` and 32 hex digits), which is no Bot's.
   */
  const teachBrowser: ComputerFleet["computers"][number] = {
    computer: "bot:person-5f0e3c1a9b7d4e2f8a6c0b1d3e5f7a9c",
    kind: "bot",
    botId: "person-5f0e3c1a9b7d4e2f8a6c0b1d3e5f7a9c",
    running: true,
    startedAt: "2026-11-07T04:15:46.000Z",
    egress: "network policy filter",
  };

  /** One row of the browsers section, by its title. */
  function browserRow(
    view: Awaited<ReturnType<typeof renderPage>>,
    title: string,
  ) {
    const section = view.getByRole("heading", {
      name: /^(Your Bots' browsers|Computers in this deployment)$/,
    }).parentElement?.parentElement as HTMLElement;
    return within(section)
      .getByText(title)
      .closest('[data-slot="item"]') as HTMLElement;
  }

  // FOUND ON WINDOWS: after Teach a Bot recorded, the person's own browser was listed as "A Bot no longer here", with
  // a Reset that said it deleted the Bot's browser profile.
  test("in the personal edition names Teach a Bot's browser as yours, with a clear for it instead of a Bot's Reset", async () => {
    const view = await renderPage("personal", hostAccess, {
      ...fleet,
      computers: [...fleet.computers, teachBrowser],
    });
    const browsers = view.getByRole("heading", { name: "Your Bots' browsers" })
      .parentElement?.parentElement as HTMLElement;
    await within(browsers).findByText("Your OpenBot browser");
    expect(browsers.textContent).not.toContain("A Bot no longer here");

    const own = browserRow(view, "Your OpenBot browser");
    expect(own.textContent).toContain("You record in it with Teach a Bot.");
    expect(
      within(own).getByRole("button", { name: "Stop browser" }),
    ).toBeTruthy();
    expect(
      within(own).getByRole("button", { name: "Clear browser data" }),
    ).toBeTruthy();
    expect(within(own).queryByRole("button", { name: "Reset" })).toBeNull();

    // The Bot's own row keeps its Reset.
    const bot = browserRow(view, "Personal Assistant");
    expect(within(bot).getByRole("button", { name: "Reset" })).toBeTruthy();

    const text = view.container.textContent ?? "";
    expect(text).not.toContain("closes a Bot's browser");
    expect(text).toContain(
      "Clear browser data does the same for your OpenBot browser.",
    );
  });

  test("in the personal edition says a stopped OpenBot browser opens when you record", async () => {
    const view = await renderPage("personal", hostAccess, {
      ...fleet,
      computers: [{ ...teachBrowser, running: false, startedAt: null }],
    });
    const own = browserRow(view, "Your OpenBot browser");
    expect(own.textContent).toContain(
      "No browser running. It opens when you record with Teach a Bot.",
    );
    expect(own.textContent).not.toContain("when the Bot next needs it");
  });

  test("in the team edition names whose OpenBot browser it is, never a Bot that is gone", async () => {
    const view = await renderPage("team", hostAccess, {
      isolation: "per-person",
      computers: [
        {
          ...teachBrowser,
          person: { name: "Ada", email: "ada@acme.test" },
        },
        {
          ...teachBrowser,
          computer: "bot:person-00000000000000000000000000000000",
          botId: "person-00000000000000000000000000000000",
        },
      ],
    });
    const ada = browserRow(view, "Ada's OpenBot browser");
    expect(ada.textContent).toContain("Their own browser for Teach a Bot");
    expect(ada.textContent).not.toContain("Isolated");
    expect(view.getByText("A person's OpenBot browser")).toBeTruthy();
    expect(view.container.textContent).not.toContain("A Bot no longer here");

    within(ada).getByRole("button", { name: "Reset" }).click();
    const dialog = await view.findByRole("dialog");
    expect(dialog.textContent).toContain("Reset Ada's OpenBot browser?");
    expect(dialog.textContent).toContain(
      "The person is signed out of every site they signed in to in it.",
    );
    expect(dialog.textContent).not.toContain("The Bot is signed out");
  });

  /** The section the desktop's folder picker is reached from. */
  function foldersSection(view: Awaited<ReturnType<typeof renderPage>>) {
    return view.getByRole("heading", { name: "Folders on this computer" })
      .parentElement?.parentElement as HTMLElement;
  }

  // OpenBot Desktop gives its server a host, and the personal edition allows it, so a Bot's row
  // offers the picker. It answered "isn't part of OpenBot Personal".
  test("in OpenBot Desktop offers each Bot a folder", async () => {
    const view = await renderPage("personal", {
      ...hostAccess,
      desktop: true,
      connected: true,
    });
    const folders = foldersSection(view);
    expect(within(folders).getByText("Personal Assistant")).toBeTruthy();
    const choose = within(folders).getByRole("button", {
      name: "Choose folder",
    }) as HTMLButtonElement;
    expect(choose.disabled).toBe(false);
    expect(folders.textContent).toContain("Folders are read-only.");
  });

  // Started with scripts/start.sh, or anywhere but the desktop: no host will ever answer, so the
  // section says what is missing instead of offering a picker that cannot open.
  test("outside OpenBot Desktop says the folders need it, with no picker to press", async () => {
    const view = await renderPage("personal", {
      ...hostAccess,
      desktop: false,
    });
    const folders = foldersSection(view);
    expect(within(folders).getByText("Needs OpenBot Desktop")).toBeTruthy();
    expect(
      within(folders).queryByRole("button", { name: "Choose folder" }),
    ).toBeNull();
    expect(
      within(folders).queryByRole("button", { name: "Stop folder access" }),
    ).toBeNull();
    expect(folders.textContent).not.toContain("The desktop app is offline");
  });

  /** A folder request still open, as `GET /api/host-access` lists it. */
  function waiting(
    kind: NonNullable<HostAccessStatus["pending"][number]["kind"]>,
    botId = "personal-assistant",
  ): HostAccessStatus["pending"][number] {
    return {
      operationId: `op-${kind}`,
      kind,
      botId,
      actorId: "dev-local-user",
    };
  }

  const granted: HostAccessStatus = {
    ...hostAccess,
    desktop: true,
    connected: true,
    grants: [
      {
        id: "host-grant-1",
        botId: "personal-assistant",
        actorId: "dev-local-user",
        displayName: "share",
        revoked: false,
      },
    ],
  };

  // FOUND ON WINDOWS: behind OpenBot Desktop's own dialog the row read "Folder access waiting for
  // approval from the desktop owner." The desktop owner is the person reading it.
  test("in the personal edition a waiting folder says OpenBot Desktop is asking you", async () => {
    const view = await renderPage("personal", {
      ...hostAccess,
      desktop: true,
      connected: true,
      pending: [waiting("choose_folder")],
    });
    const text = foldersSection(view).textContent ?? "";
    expect(text).toContain("1 pending request");
    expect(text).toContain(
      "Folder access is waiting for you. OpenBot Desktop is asking you in a window.",
    );
    expect(text).not.toContain("desktop owner");
  });

  test("in the personal edition a file change or command waits on you, and reading waits on nobody", async () => {
    const view = await renderPage("personal", {
      ...granted,
      pending: [
        waiting("write_file"),
        waiting("run_command"),
        waiting("list_files"),
        waiting("read_file"),
      ],
    });
    const text = foldersSection(view).textContent ?? "";
    expect(text).toContain(
      "A file change is waiting for you. OpenBot Desktop is asking you in a window.",
    );
    expect(text).toContain(
      "A command is waiting for you or still running. OpenBot Desktop asks you in a window.",
    );
    expect(text).toContain("Listing files.");
    expect(text).toContain("Reading a file.");
    expect(text).not.toContain("from the desktop owner");
    expect(text).not.toContain("desktop owner");
  });

  // A granted folder's line began "the desktop owner · Read-only".
  test("in the personal edition a granted folder reads as read-only, naming no owner", async () => {
    const view = await renderPage("personal", granted);
    const folders = foldersSection(view);
    expect(within(folders).getByText("share")).toBeTruthy();
    expect(within(folders).getByText("Read-only")).toBeTruthy();
    expect(folders.textContent).not.toContain("desktop owner");
  });

  // Stop folder access is queued for every Bot ("*"). It drew a row of its own, "A Bot no longer
  // here", until the desktop picked it up.
  test("stopping folder access draws no row for a Bot that isn't there", async () => {
    const view = await renderPage("personal", {
      ...granted,
      pending: [waiting("stop", "*")],
    });
    const folders = foldersSection(view);
    expect(folders.textContent).not.toContain("A Bot no longer here");
    expect(folders.textContent).not.toContain("1 pending request");
  });

  // In the team edition the desktop's owner may be somebody other than the admin reading, so a
  // request waiting on them still says so. Listing and reading wait on nobody.
  test("in the team edition a waiting request names the desktop owner, and reading names nobody", async () => {
    const view = await renderPage("team", {
      ...granted,
      pending: [
        waiting("choose_folder"),
        waiting("write_file"),
        waiting("list_files"),
      ],
    });
    const text = foldersSection(view).textContent ?? "";
    expect(text).toContain(
      "Folder access waiting for approval from the desktop owner.",
    );
    expect(text).toContain(
      "File change waiting for approval from the desktop owner, or to finish.",
    );
    expect(text).toContain("Listing files.");
    expect(text).not.toContain("Listing files from");
    expect(text).toContain("Approved by the desktop owner · Read-only");
    expect(text).not.toContain("OpenBot Desktop is asking you");
  });

  test("in the team edition still tells an admin how to give each person a computer", async () => {
    const view = await renderPage("team");
    const text = view.container.textContent ?? "";
    expect(view.getByRole("heading", { name: "Computers" })).toBeTruthy();
    expect(text).toContain("COMPUTER_SUPERVISOR_URL");
    expect(text).toContain("Computers in this deployment");
    expect(text).toContain("dev@openbot.local · Personal Assistant");
    expect(text).toContain("Leaves through network policy filter");
  });
});
