import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AccessSections } from "@/components/bot-profile/access";
import type { AgentProfile } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Skills and access page. A person may put their own skill on a Bot they own, and only
 * that, so the switches are their own skills on their own Bot.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const BOT: AgentProfile = {
  id: "expenses",
  name: "Expenses",
  title: "Finance",
  roleDescription: "Receipts.",
  avatarSeed: "e",
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

const skill = (
  slug: string,
  ownerUserId: string | null,
  grantedTo: string[],
  title = slug,
) => ({
  id: slug,
  slug,
  ownerUserId,
  title,
  summary: `${slug} summary`,
  instructions: "",
  origin: "user",
  installedBy: null,
  grantedTo,
  tools: [],
});

const grants: string[] = [];
/**
 * The server's grants, as the real one keeps them: one set behind both reads, the skills page's
 * `grantedTo` and the Bot's own list. `givesOnListing` is the personal edition giving a Bot every
 * skill the first time its own list is read (server/src/plugins/personal-defaults.ts).
 */
function serving(options: { held?: string[]; givesOnListing?: boolean } = {}) {
  grants.length = 0;
  const held = new Set(options.held ?? ["mine-on"]);
  const all = [
    { slug: "mine-on", owner: "me", title: "mine-on" },
    { slug: "mine-off", owner: "me", title: "mine-off" },
    { slug: "theirs", owner: "other", title: "theirs" },
    // A skill whose title is not its slug, as every skill a person writes has.
    { slug: "tide-report", owner: "me", title: "Tide report" },
  ];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/plugins/grants")) {
      grants.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      return Response.json({ ok: true });
    }
    if (url.includes("/api/plugins/for/") && url.endsWith("/apps")) {
      return Response.json({ apps: [] });
    }
    if (url.includes("/api/plugins/for/")) {
      if (options.givesOnListing) for (const { slug } of all) held.add(slug);
      return Response.json({
        tools: [],
        skills: all
          .filter(({ slug }) => held.has(slug))
          .map(({ slug, title }) => ({
            slug,
            title,
            summary: `${slug} summary`,
            instructions: "",
          })),
      });
    }
    if (url.endsWith("/api/plugins")) {
      return Response.json({
        catalogue: [],
        servers: [],
        botsMayCallBack: true,
        redirectUri: null,
        skills: all.map(({ slug, owner, title }) =>
          skill(slug, owner, held.has(slug) ? ["expenses"] : [], title),
        ),
      });
    }
    if (url.includes("/handoff")) {
      return Response.json({
        handoff: {
          enabled: true,
          canGrant: false,
          reachable: [],
          grantable: true,
        },
      });
    }
    if (url.includes("/api/agents")) return Response.json({ agents: [] });
    return Response.json({
      user: { id: "me", role: "user", email: "me@example.test", name: "Me" },
    });
  }) as unknown as typeof fetch;
}

function draw(agent: AgentProfile) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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

test("your own skills each have a switch that reflects whether this Bot carries it", async () => {
  serving();
  const view = draw(BOT);
  const on = await view.findByRole("switch", { name: "mine-on" });
  const off = view.getByRole("switch", { name: "mine-off" });
  expect(on.getAttribute("aria-checked")).toBe("true");
  expect(off.getAttribute("aria-checked")).toBe("false");
  // Somebody else's skill is not offered: the server would refuse it.
  expect(view.queryByRole("switch", { name: "theirs" })).toBeNull();
});

/*
 * FOUND ON WINDOWS (0.3.4 release candidates): Your skills listed "/tide-report" above What it can
 * use's "Tide report", one skill under two names. Both say its title; the section says to type /.
 */
test("a skill is named by its title, never listed again by its slug", async () => {
  serving({ held: ["tide-report"] });
  const view = draw(BOT);
  const tide = await view.findByRole("switch", { name: "Tide report" });
  expect(tide.getAttribute("aria-checked")).toBe("true");
  await view.findByText("Type / in a conversation to run it.", {
    exact: false,
  });
  // Once in Your skills and once in What it can use, by the same name.
  await waitFor(() => expect(view.getAllByText("Tide report").length).toBe(2));
  expect(view.container.textContent).not.toContain("/tide-report");
});

test("a Bot made a moment ago shows the skills its first listing gave it", async () => {
  // A brand-new Bot in the personal edition: nothing granted until its own list is read.
  serving({ held: [], givesOnListing: true });
  const view = draw(BOT);
  const on = await view.findByRole("switch", { name: "mine-on" });
  expect(on.getAttribute("aria-checked")).toBe("true");
  expect(
    view.getByRole("switch", { name: "mine-off" }).getAttribute("aria-checked"),
  ).toBe("true");
});

test("switching a skill on grants it to this Bot", async () => {
  serving();
  const view = draw(BOT);
  fireEvent.click(await view.findByRole("switch", { name: "mine-off" }));
  await waitFor(() => expect(grants).toHaveLength(1));
  expect(grants[0]).toContain("POST");
  expect(grants[0]).toContain("mine-off");
  expect(grants[0]).toContain("expenses");
});

test("on a Bot that is not yours there are no skill switches", async () => {
  serving({ held: [] });
  const view = draw({ ...BOT, mine: false, canManage: false });
  expect(await view.findByText("No apps yet")).toBeTruthy();
  expect(view.getByText(/^An admin has to add them\./)).toBeTruthy();
  expect(view.queryByRole("switch")).toBeNull();
});

test("your skills failing to load says so, not that you have none", async () => {
  serving();
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith("/api/plugins")
      ? new Response(null, { status: 500 })
      : served(input, init)) as unknown as typeof fetch;
  const view = draw(BOT);
  expect(
    await view.findByText("Couldn't load your skills. Reload the page."),
  ).toBeTruthy();
  expect(view.queryByText(/No skills yet/)).toBeNull();
});

test("this Bot's own skills failing to load says so, rather than drawing every switch off", async () => {
  serving();
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith("/api/plugins/for/expenses")
      ? new Response(null, { status: 500 })
      : served(input, init)) as unknown as typeof fetch;
  const view = draw(BOT);
  expect(
    await view.findByText("Couldn't load your skills. Reload the page."),
  ).toBeTruthy();
  expect(view.queryByRole("switch", { name: "mine-on" })).toBeNull();
});
