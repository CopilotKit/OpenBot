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
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewSkillPage } from "@/components/manage/new-skill-page";
import { SkillPage } from "@/components/manage/skill-page";
import { SkillsPage } from "@/components/manage/skills-page";
import { type PluginSkill, pluginKeys } from "@/lib/plugins/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The deployment's Skills under Admin: a list whose rows open each skill's page, a page of its own
 * for writing one, and the skill's page with a switch per Bot and deleting behind a confirmation.
 *
 * Drawn under the real paths (`/admin/skills`, `/admin/skills/new`, `/admin/skills/$slug`) so every
 * link and every navigation is the one the app makes, against a fake `fetch` that records writes.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let writes: { method: string; path: string; body: unknown }[];
let skills: PluginSkill[];

function skill(overrides: Partial<PluginSkill> = {}): PluginSkill {
  return {
    id: "skill-triage",
    slug: "triage",
    ownerUserId: null,
    title: "Triage the inbox",
    summary: "Sorts new mail by what needs an answer",
    instructions: "Read my unread mail and sort it.",
    origin: "admin",
    installedBy: null,
    grantedTo: ["bot-ada"],
    tools: [],
    ...overrides,
  };
}

beforeEach(() => {
  writes = [];
  skills = [skill()];
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const path = url.split("?")[0] ?? url;
      const method = init?.method ?? "GET";
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      if (method !== "GET") {
        writes.push({
          method,
          path: url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return json({ ok: true });
      }
      if (path === "/api/agents")
        return json({
          agents: url.includes("hidden=true")
            ? []
            : [
                { id: "bot-ada", name: "Ada" },
                { id: "bot-grace", name: "Grace" },
              ],
        });
      if (path === "/api/plugins")
        return json({
          catalogue: [],
          servers: [
            {
              id: "notion",
              title: "Notion",
              logo: null,
              tools: [
                {
                  name: "search_pages",
                  description: "Search pages by title. Returns ids.",
                  ref: "notion/search_pages",
                  effect: "read",
                },
                {
                  name: "create_page",
                  description: "Create a page.",
                  ref: "notion/create_page",
                  effect: "write",
                },
              ],
            },
          ],
          skills,
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: false,
          authorizesPerAction: false,
        });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function renderAt(path: string) {
  const root = createRootRoute({ component: Outlet });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/admin/skills",
    component: SkillsPage,
  });
  const create = createRoute({
    getParentRoute: () => root,
    path: "/admin/skills/new",
    component: NewSkillPage,
  });
  const one = createRoute({
    getParentRoute: () => root,
    path: "/admin/skills/$slug",
    component: function One() {
      const { slug } = one.useParams();
      return <SkillPage slug={slug} />;
    },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([list, create, one]),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

describe("the Skills list", () => {
  test("each row opens the skill's page and says how many Bots offer it", async () => {
    const { view } = renderAt("/admin/skills");
    const row = (await view.findByText("Triage the inbox")).closest("a");
    expect(row?.getAttribute("href")).toBe("/admin/skills/triage");
    expect(
      within(row as HTMLElement).getByText(
        "Sorts new mail by what needs an answer",
      ),
    ).toBeTruthy();
    // The command is the skill's key, not something to read, and the row has no icon.
    expect(row?.textContent).not.toContain("/triage");
    expect(row?.querySelector("svg.tabler-icon-file-text")).toBeNull();
    expect(within(row as HTMLElement).getByText("1 of 2 Bots")).toBeTruthy();
    // No chip per Bot and no Remove on the row: those are on the skill's page.
    expect(view.queryByRole("button", { name: "Ada" })).toBeNull();
    expect(view.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(view.container.textContent).not.toContain("every Bot");
  });

  test("New skill is a link to its own page", async () => {
    const { view } = renderAt("/admin/skills");
    await view.findByText("Triage the inbox");
    expect(view.getByText("New skill").closest("a")?.getAttribute("href")).toBe(
      "/admin/skills/new",
    );
  });
});

describe("writing a skill", () => {
  test("saves it for the deployment and opens its page to choose the Bots", async () => {
    const { view, router } = renderAt("/admin/skills/new");
    const user = userEvent.setup({ document });
    await user.type(await view.findByLabelText("Command"), "Standup");
    await user.type(view.getByLabelText("Title"), "Standup notes");
    await user.type(
      view.getByLabelText("Instructions"),
      "Summarise yesterday.",
    );
    skills = [...skills, skill({ id: "skill-standup", slug: "standup" })];
    await user.click(view.getByRole("button", { name: "Save skill" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/admin/skills/standup"),
    );
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/api/plugins/skills",
        body: expect.objectContaining({
          slug: "standup",
          title: "Standup notes",
          instructions: "Summarise yesterday.",
          global: true,
        }),
      },
    ]);
  });
});

describe("choosing a skill's tools", () => {
  test("each app is one row, and its tools are ticked in a dialog", async () => {
    const { view } = renderAt("/admin/skills/new");
    const user = userEvent.setup({ document });
    const notion = (await view.findByText("Notion")).closest("button");
    expect(within(notion as HTMLElement).getByText("None")).toBeTruthy();
    // No button per tool on the page itself.
    expect(view.queryByRole("button", { name: "search_pages" })).toBeNull();

    await user.click(notion as HTMLElement);
    const dialog = await view.findByRole("dialog");
    // Named for people, described by the first sentence, writes marked.
    expect(within(dialog).getByText("Search pages")).toBeTruthy();
    expect(within(dialog).getByText("Search pages by title.")).toBeTruthy();
    expect(within(dialog).getByText("changes things")).toBeTruthy();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Use Search pages" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Done" }));

    const row = view.getByText("Notion").closest("button") as HTMLElement;
    expect(within(row).getByText("Search pages")).toBeTruthy();
    expect(within(row).getByText("1 of 2 tools")).toBeTruthy();

    await user.type(view.getByLabelText("Title"), "Find a page");
    await user.type(view.getByLabelText("Command"), "find");
    await user.type(view.getByLabelText("Instructions"), "Find it.");
    await user.click(view.getByRole("button", { name: "Save skill" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toMatchObject({ tools: ["notion/search_pages"] });
  });

  test("Select all ticks every tool of the app", async () => {
    const { view } = renderAt("/admin/skills/new");
    const user = userEvent.setup({ document });
    await user.click(
      (await view.findByText("Notion")).closest("button") as HTMLElement,
    );
    const dialog = await view.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Select all" }),
    );
    expect(
      within(dialog).getByRole("button", { name: "Clear all" }),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    const row = view.getByText("Notion").closest("button") as HTMLElement;
    expect(within(row).getByText("All 2 tools")).toBeTruthy();
  });
});

describe("a skill's page", () => {
  test("each Bot's switch offers or withdraws the skill at once", async () => {
    const { view } = renderAt("/admin/skills/triage");
    const grace = await view.findByRole("switch", {
      name: "Grace offers Triage the inbox",
    });
    fireEvent.click(grace);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: "POST",
      path: "/api/plugins/grants",
      body: { kind: "skill", ref: "triage", agentId: "bot-grace" },
    });
    fireEvent.click(
      view.getByRole("switch", { name: "Ada offers Triage the inbox" }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.method).toBe("DELETE");
    expect(writes[1]?.path).toBe(
      "/api/plugins/grants?kind=skill&ref=triage&agentId=bot-ada",
    );
  });

  test("deleting asks first, then goes back to the list", async () => {
    const { view, router } = renderAt("/admin/skills/triage");
    const user = userEvent.setup({ document });
    await user.click(
      await view.findByRole("button", { name: /^Delete People can.t run it/ }),
    );
    expect(writes).toEqual([]);
    const dialog = await view.findByRole("dialog");
    expect(within(dialog).getByText("Delete Triage the inbox?")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/admin/skills"),
    );
    expect(writes).toEqual([
      { method: "DELETE", path: "/api/plugins/skills/triage", body: null },
    ]);
  });

  test("a skill that is not there says so", async () => {
    const { view } = renderAt("/admin/skills/gone");
    expect(await view.findByText("Skill not found")).toBeTruthy();
  });
});

test("the list reads its skills from the plugins page", () => {
  // Guards the cache key these pages share with the rest of Admin.
  expect(pluginKeys.page()).toEqual(["plugins", "page"]);
});
