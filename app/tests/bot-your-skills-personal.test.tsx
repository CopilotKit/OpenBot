import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { AccessSections } from "@/components/bot-profile/access";
import type { AgentProfile } from "@/lib/agents/queries";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { DEV_ACTOR } from "../../server/src/auth/dev-actor";
import { setEdition } from "../../server/src/edition";
import {
  type PersonalDefaultsDeps,
  withPersonalDefaults,
} from "../../server/src/plugins/personal-defaults";
import type {
  GrantedPlugins,
  SkillActor,
  SkillRecord,
} from "../../server/src/plugins/plugin-store/model";
import { createPluginRoutes } from "../../server/src/plugins/routes";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's "Your skills" in the personal edition, after the person wrote a skill on Settings > Skills.
 *
 * The skill is written and listed by the server's own routes, mounted behind `fetch`, with the
 * personal edition's defaults around the store, so what the section draws is what that server
 * answers. Settings > Skills saves with `global`, and the route used to store the skill as
 * nobody's: the Bot held it, and its "Your skills" read "No skills yet".
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  setEdition("team");
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setEdition("team");
});

const BOT: AgentProfile = {
  id: "harbour-pilot",
  name: "Harbour Pilot",
  title: "Harbour Pilot",
  roleDescription: "Brings ships in.",
  avatarSeed: "h",
  visibility: "private",
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
  canManage: true,
  mine: true,
};

type Row = Omit<SkillRecord, "grantedTo" | "tools">;

/**
 * The plugin store, kept in memory: the methods these routes and the personal defaults call, each
 * answering in the shape the real one does (`plugin-store/skills.ts`, `plugin-store/grants.ts`).
 */
function memoryStore() {
  const rows = new Map<string, Row>();
  const grants = new Set<string>();
  const bots: string[] = [];
  const given = new Set<string>();
  const key = (slug: string, agentId: string) => `${slug}\u0000${agentId}`;
  // Shipped with OpenBot: the deployment's, so never one of "Your skills".
  rows.set("find-a-document", {
    id: "find-a-document",
    slug: "find-a-document",
    ownerUserId: null,
    title: "Find a document",
    summary: "Search the connected document sources.",
    instructions: "Search.",
    origin: "catalogue",
    installedBy: null,
  });
  const store = {
    brokerProvider: "composio" as const,
    async listServers() {
      return [];
    },
    async listSkills(actor?: SkillActor): Promise<SkillRecord[]> {
      return [...rows.values()]
        .filter(
          (row) =>
            !actor ||
            actor.isAdmin ||
            row.ownerUserId === null ||
            row.ownerUserId === actor.id,
        )
        .map((row) => ({
          ...row,
          grantedTo: bots.filter((bot) => grants.has(key(row.slug, bot))),
          tools: [],
        }));
    },
    async skillOwner(slug: string) {
      const row = rows.get(slug);
      return row ? row.ownerUserId : undefined;
    },
    async installSkill(input: {
      slug: string;
      title: string;
      summary: string;
      instructions: string;
      ownerUserId: string | null;
      by: string;
    }) {
      const before = rows.get(input.slug);
      rows.set(input.slug, {
        id: input.slug,
        slug: input.slug,
        // An edit keeps the owner and the first installer, as the real upsert does.
        ownerUserId: before ? before.ownerUserId : input.ownerUserId,
        title: input.title,
        summary: input.summary,
        instructions: input.instructions,
        origin: "yours",
        installedBy: before ? before.installedBy : input.by,
      });
    },
    async grant(_kind: "mcp" | "skill", ref: string, agentId: string) {
      grants.add(key(ref, agentId));
    },
    async grantTools() {},
    async refreshTools() {
      return { tools: 0 };
    },
    async listForAgent(agentId: string): Promise<GrantedPlugins> {
      return {
        tools: [],
        skills: [...rows.values()]
          .filter((row) => grants.has(key(row.slug, agentId)))
          .map(({ slug, title, summary, instructions }) => ({
            slug,
            title,
            summary,
            instructions,
            tools: [],
          })),
      };
    },
  };
  const deps: PersonalDefaultsDeps = {
    tools: async () => [],
    bots: async () => [...bots],
    granted: async () => new Set(),
    servers: async () => [],
    skillExists: async (slug) => rows.has(slug),
    skills: async () => [...rows.keys()],
    heldSkills: async (agentId) =>
      new Set(
        [...rows.keys()].filter((slug) => grants.has(key(slug, agentId))),
      ),
    skillsGiven: async (agentId) => given.has(agentId),
    rememberSkillsGiven: async (agentId) => {
      given.add(agentId);
    },
    includeEveryBotInLearning: async () => [],
  };
  return {
    store: withPersonalDefaults(store, deps),
    /** New Bot: a Bot that exists from now on. */
    makeBot: (id: string) => bots.push(id),
  };
}

/**
 * The server, behind `fetch`. `/api/plugins` is the plugin routes themselves, as the personal
 * edition's one person, an administrator. The page's other reads answer empty.
 */
function serve(store: ReturnType<typeof memoryStore>["store"]) {
  const plugins = createPluginRoutes(
    store as never,
    async (context, next) => {
      context.set("actor", DEV_ACTOR);
      await next();
    },
    async () => true,
  );
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1");
    const path = url.pathname;
    // Apps are not what this is about: the Bot's apps and the ones it could be given answer empty.
    if (path.endsWith("/apps") || path.endsWith("/giveable")) {
      return Response.json({ apps: [] });
    }
    if (path.startsWith("/api/plugins")) {
      return plugins.request(
        `${path.slice("/api/plugins".length) || "/"}${url.search}`,
        init,
      );
    }
    if (path.includes("/handoff")) {
      return Response.json({
        handoff: {
          enabled: true,
          canGrant: false,
          reachable: [],
          grantable: true,
        },
      });
    }
    if (path.startsWith("/api/agents")) return Response.json({ agents: [] });
    if (path === "/api/me") return Response.json({ user: DEV_ACTOR });
    return Response.json({});
  }) as unknown as typeof fetch;
}

function draw(client: QueryClient, agent: AgentProfile) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => <AccessSections agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("a skill written on Settings > Skills shows under a new Bot's Your skills, switched on", async () => {
  setEdition("personal");
  const { store, makeBot } = memoryStore();
  serve(store);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  // Settings > Skills, as `new-skill-page.tsx` saves it.
  await new MutationObserver(client, saveSkillMutationOptions(client)).mutate({
    slug: "tide-report",
    title: "Tide report",
    summary: "When the tide turns at the harbour mouth.",
    instructions: "Read the tide table and say when it turns.",
    tools: [],
    global: true,
  });
  // Then New Bot.
  makeBot(BOT.id);

  const view = draw(client, BOT);
  // By its title, as What it can use names it; never "/tide-report" beside "Tide report".
  const tide = await view.findByRole("switch", { name: "Tide report" });
  expect(tide.getAttribute("aria-checked")).toBe("true");
  expect(view.queryByText("/tide-report")).toBeNull();
  expect(view.queryByText("No skills yet")).toBeNull();
  // A skill OpenBot ships is not one the person wrote.
  expect(view.queryByRole("switch", { name: "Find a document" })).toBeNull();
});
