import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { BotSettingsRows } from "@/components/bot-profile/settings-rows";
import type { AgentProfile } from "@/lib/agents/queries";
import { settleReactWork } from "./settle-react-work";

/** The "Settings for this Bot" card: each row says its current answer and opens its page. */

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
  visibility: "public",
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

function serving(
  role: "admin" | "user",
  teamBots: { id: string; audience: "team" | "people" }[] = [],
) {
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/routines")) {
      return Response.json({
        routines: [{ id: "r1", agentId: "expenses" }],
        sweep: null,
      });
    }
    if (url.includes("/api/plugins/for/")) {
      return Response.json({ tools: [], skills: [] });
    }
    if (url.includes("/api/team-bots")) {
      return Response.json({ teamBots, publishable: [] });
    }
    if (url === "/api/responsibilities") {
      return Response.json({
        responsibilities: [
          { id: "g1", agentId: "expenses", status: "active" },
          { id: "g2", agentId: "expenses", status: "paused" },
          { id: "g3", agentId: "knowledge", status: "active" },
        ],
      });
    }
    if (url === "/api/delivery") {
      return Response.json({
        bindings: [
          { id: "b1", transport: "slack", agentId: "expenses", enabled: true },
          { id: "b2", transport: "sms", agentId: "knowledge", enabled: true },
        ],
        devices: [],
        deliveries: [],
        available: { slack: true, teams: false, sms: true, push: false },
      });
    }
    if (url === "/api/memory/sources") {
      return Response.json({
        sources: [{ id: "s1", agentId: "expenses", enabled: true }],
      });
    }
    if (url === "/api/proactive/settings") {
      return Response.json({ settings: [], allowed: true });
    }
    if (url === "/api/approvals") {
      return Response.json({
        enabled: true,
        requests: [],
        questions: [],
        rules: [
          { id: "r1", botId: "expenses" },
          { id: "r2", botId: "*" },
        ],
        teamRules: [],
      });
    }
    return Response.json({
      user: { id: "me", role, email: "me@example.test", name: "Me" },
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
      component: () => <BotSettingsRows agent={agent} />,
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

test("the owner sees Sharing, and each row opens its own page", async () => {
  serving("user");
  const view = draw(BOT);
  const sharing = (await view.findByText("Sharing")).closest("a");
  expect(sharing?.getAttribute("href")).toBe("/bots/expenses/sharing");
  expect(view.getByText("Setup").closest("a")?.getAttribute("href")).toBe(
    "/bots/expenses/setup",
  );
  // Public and unpublished: everyone can already use it.
  expect(await view.findByText("Everyone (public)")).toBeTruthy();
});

test("someone who neither owns the Bot nor administers the deployment does not see Sharing", async () => {
  serving("user");
  const view = draw({ ...BOT, mine: false, canManage: false });
  expect(await view.findByText("Setup")).toBeTruthy();
  expect(view.queryByText("Sharing")).toBeNull();
});

test("the personal edition has three rows: Routines, What it can do and Setup", async () => {
  serving("admin");
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/capabilities"
      ? Response.json({ edition: "personal" })
      : served(input, init)) as unknown as typeof fetch;
  const view = draw(BOT);
  expect(await view.findByText("Setup")).toBeTruthy();
  // The capabilities answer arrives on its own request; wait for the row it removes to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Nobody to share a Bot with.
  expect(view.queryByText("Sharing")).toBeNull();
  // Approval rules, Goals and check-ins are sections of What it can do; no Slack, Teams or text,
  // and no memory, which the personal edition's Intelligence isn't licensed for.
  expect(view.getByText("What it can do")).toBeTruthy();
  for (const gone of [
    "Skills and access",
    "Approval rules",
    "Goals",
    "Reaching you",
    "Memory",
  ])
    expect(view.queryByText(gone)).toBeNull();
  expect(view.getByText("Routines")).toBeTruthy();
  expect(view.container.querySelector('a[href$="/memory"]')).toBeNull();
});

test("an administrator sees Sharing on somebody else's Bot", async () => {
  serving("admin");
  const view = draw({ ...BOT, mine: false });
  expect(await view.findByText("Sharing")).toBeTruthy();
});

test("someone a Bot was published to sees Sharing, where its link is", async () => {
  serving("user", [{ id: "expenses", audience: "team" }]);
  const view = draw({ ...BOT, mine: false, canManage: false });
  expect(await view.findByText("Sharing")).toBeTruthy();
  expect(await view.findByText("Whole team")).toBeTruthy();
});

test("the rows for goals, reach, memory and rules say what this Bot has and open their pages", async () => {
  serving("user");
  const view = draw(BOT);
  const row = async (title: string, summary: string, path: string) => {
    expect(await view.findByText(summary)).toBeTruthy();
    expect(view.getByText(title).closest("a")?.getAttribute("href")).toBe(
      `/bots/expenses/${path}`,
    );
  };
  await row("Goals", "1 active", "responsibilities");
  await row("Reaching you", "Slack", "reach");
  await row("Memory", "1 source", "memory");
  await row("Approval rules", "1 rule", "approvals");
});

/** The personal starter on the harness picked at setup, as OpenBot Desktop on Windows starts it. */
const ON_HARNESS: AgentProfile = {
  ...BOT,
  endpoint: "http://agent-harness:4206/ag-ui",
  builtIn: false,
  keyFromOpenBot: true,
  framework: "LangChain",
};

function withEdition(edition: "team" | "personal") {
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/capabilities"
      ? Response.json({ edition })
      : served(input, init)) as unknown as typeof fetch;
}

test("the personal edition's Setup row names the Bot's framework, not the harness's address", async () => {
  serving("admin");
  withEdition("personal");
  const view = draw(ON_HARNESS);
  expect(await view.findByText("Runs on LangChain")).toBeTruthy();
  expect(view.queryByText("agent-harness:4206")).toBeNull();
});

test("a team deployment's Setup row still shows the address", async () => {
  serving("admin");
  withEdition("team");
  const view = draw(ON_HARNESS);
  expect(await view.findByText("Setup")).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(view.getByText("agent-harness:4206")).toBeTruthy();
  expect(view.queryByText("Runs on LangChain")).toBeNull();
});
