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
import { cleanup, render } from "@testing-library/react";
import { PluginToolPage } from "@/components/manage/plugin-tool-page";
import { SkillsPage } from "@/components/manage/skills-page";
import { settingsSidebarItems } from "@/components/settings/settings-sidebar";
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
  ["Skills for every Bot", "/settings/skills"],
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

  test("name the skills page apart from a person's own skills", async () => {
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
    expect(
      await view.findByRole("heading", { name: "Skills for every Bot" }),
    ).toBeTruthy();
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
