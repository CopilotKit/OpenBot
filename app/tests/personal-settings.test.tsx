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

  test("has no Learning page, which is about sharing Skills with other people", async () => {
    expect(
      settingsSidebarItems("personal").map((item) => item.title),
    ).not.toContain("Learning");
    expect(settingsSidebarItems("team").map((item) => item.title)).toContain(
      "Learning",
    );
    const guard = LearningRoute.options.beforeLoad as unknown as (input: {
      context: { queryClient: QueryClient };
    }) => Promise<unknown>;
    let sentTo: unknown = "open";
    try {
      await guard({ context: { queryClient: clientFor("personal") } });
    } catch (thrown) {
      sentTo = isRedirect(thrown) ? thrown.options.to : thrown;
    }
    expect(sentTo).toBe("/settings");
    await expect(
      guard({ context: { queryClient: clientFor("team") } }),
    ).resolves.toBeUndefined();
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

  async function renderPage(edition: "team" | "personal") {
    const client = clientFor(edition);
    client.setDefaultOptions({
      queries: { retry: false, staleTime: Infinity },
    });
    client.setQueryData(computerKeys.fleet(), fleet);
    client.setQueryData(hostAccessKeys.status(), hostAccess);
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
