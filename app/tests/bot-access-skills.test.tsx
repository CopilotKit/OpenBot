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

/**
 * A Bot's Skills and access page. A person may put their own skill on a Bot they own, and only
 * that, so the switches are their own skills on their own Bot.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

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
) => ({
  id: slug,
  slug,
  ownerUserId,
  title: slug,
  summary: `${slug} summary`,
  instructions: "",
  origin: "user",
  installedBy: null,
  grantedTo,
  tools: [],
});

const grants: string[] = [];
function serving() {
  grants.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/plugins/grants")) {
      grants.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
      return Response.json({ ok: true });
    }
    if (url.includes("/api/plugins/for/")) {
      return Response.json({ tools: [], skills: [] });
    }
    if (url.endsWith("/api/plugins")) {
      return Response.json({
        catalogue: [],
        servers: [],
        botsMayCallBack: true,
        redirectUri: null,
        skills: [
          skill("mine-on", "me", ["expenses"]),
          skill("mine-off", "me", []),
          skill("theirs", "other", []),
        ],
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
  serving();
  const view = draw({ ...BOT, mine: false, canManage: false });
  expect(await view.findByText(/^Nothing granted yet\./)).toBeTruthy();
  expect(view.queryByRole("switch")).toBeNull();
});
