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
import { meResponse } from "./accounts-api";
import { DEPLOYMENT_PATH } from "./admin-settings-api";
import { approvalInboxResponse } from "./approvals-api";
import { botGrantsResponse } from "./bot-grants-api";
import { answerTeamBots, teamBotOf } from "./bots-api";
import {
  MEMORY,
  memoryContract,
  memorySourceBody,
  page,
  requestOf,
} from "./learning-api";
import { notificationsResponse } from "./notifications-api";
import { answerScheduleLists } from "./schedules-api";
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
  assignedToMe: false,
  runsOnOpenBotModel: false,
  keyFromOpenBot: false,
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
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const listed = answerTeamBots(
      input,
      init,
      teamBots.map((bot) =>
        teamBotOf(bot.id, bot.id, { audience: bot.audience, mine: false }),
      ),
    );
    if (listed) return listed;
    const schedules = answerScheduleLists(input, init, {
      routines: [{ id: "r1", botId: "expenses" }],
      goals: [
        { id: "g1", botId: "expenses", status: "active" },
        { id: "g2", botId: "expenses", status: "paused" },
        { id: "g3", botId: "knowledge", status: "active" },
      ],
    });
    if (schedules) return schedules;
    if (url.includes("/bots/") && url.includes("/grants")) {
      return botGrantsResponse();
    }
    if (url.endsWith("/bots/expenses/delegation")) {
      return Response.json({
        botId: "expenses",
        mode: "self",
        model: null,
        effort: null,
        instructions: "",
        agents: [
          {
            id: "bag_openbot",
            name: "OpenBot",
            description: "OpenBot's own agent.",
            kind: "openbot",
            framework: "OpenBot",
            available: true,
          },
        ],
        canManage: true,
      });
    }
    const reach = notificationsResponse("GET", url, {
      bindings: [
        { id: "b1", transport: "slack", channelId: "c1", agentId: "expenses" },
        { id: "b2", transport: "sms", channelId: "c2", agentId: "knowledge" },
      ],
      available: { slack: true, sms: true },
    });
    if (reach) return reach;
    if (requestOf(input, init).path === MEMORY.sources) {
      return page(memoryContract.ListMemorySourcesResponse, "sources", [
        memorySourceBody({ id: "s1", botId: "expenses" }),
      ]);
    }
    const approvals = approvalInboxResponse(url, {
      enabled: true,
      requests: [],
      questions: [],
      rules: [
        {
          id: "r1",
          botId: "expenses",
          toolRef: "mcp/drive/share",
          effect: "write",
          scope: "*",
          behaviour: "allow",
        },
        {
          id: "r2",
          botId: "*",
          toolRef: "mcp/drive/share",
          effect: "write",
          scope: "*",
          behaviour: "ask",
        },
      ],
      teamRules: [],
    });
    if (approvals) return approvals;
    return meResponse({
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

test("the personal edition shows Routines, Skills, Apps, Computer, Approvals, Setup and Agents, in that order", async () => {
  serving("admin");
  const served = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === DEPLOYMENT_PATH
      ? Response.json({ edition: "personal" })
      : served(input, init)) as unknown as typeof fetch;
  const view = draw(BOT);
  expect(await view.findByText("Setup")).toBeTruthy();
  // The capabilities answer arrives on its own request; wait for the rows it removes to settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const titles = [
    ...view.container.querySelectorAll('[data-slot="item-title"]'),
  ].map((title) => title.textContent);
  // Nothing else: no Memory (not offered), no Sharing (nobody to share with), no Reaching you.
  expect(titles).toEqual([
    "Routines",
    "Skills",
    "Apps",
    "Computer",
    "Approvals",
    "Setup",
    "Agents",
  ]);
  expect(view.container.querySelector('a[href$="/memory"]')).toBeNull();
});

test("the team edition keeps the order, with Memory, then Sharing and Reaching you after Setup", async () => {
  serving("user");
  const view = draw(BOT);
  expect(await view.findByText("Reaching you")).toBeTruthy();
  const titles = [
    ...view.container.querySelectorAll('[data-slot="item-title"]'),
  ].map((title) => title.textContent);
  // No Computer row: this Bot has no computer of its own, and folders need OpenBot Desktop.
  expect(titles).toEqual([
    "Routines",
    "Memory",
    "Skills",
    "Apps",
    "Approvals",
    "Setup",
    "Agents",
    "Sharing",
    "Reaching you",
  ]);
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
  expect(await view.findByText("Everyone in the organization")).toBeTruthy();
});

test("the rows for routines, reach, memory, approvals and agents say what this Bot has and open their pages", async () => {
  serving("user");
  const view = draw(BOT);
  const row = async (title: string, summary: string, path: string) => {
    expect(await view.findByText(summary)).toBeTruthy();
    expect(view.getByText(title).closest("a")?.getAttribute("href")).toBe(
      `/bots/expenses/${path}`,
    );
  };
  await row("Routines", "3 routines", "routines");
  await row("Reaching you", "Slack", "reach");
  await row("Memory", "1 source", "memory");
  await row("Approvals", "1 rule", "approvals");
  await row("Agents", "Does the work itself on OpenBot", "agents");
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
    String(input) === DEPLOYMENT_PATH
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
