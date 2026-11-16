import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { AgentList } from "@/components/bot-agents/agent-list";
import { BotDelegation } from "@/components/bot-profile/delegation";
import type { AgentProfile } from "@/lib/agents/queries";
import type {
  BotAgent,
  BotDelegation as Delegation,
} from "@/lib/api/generated/model";
import { queryClient } from "@/query-client";
import { Route as AgentsRoute } from "@/routes/_authed/_app/agents/index";
import { settleReactWork } from "./settle-react-work";

/**
 * The Agents page and a Bot's Agents page, against a server that answers only at the API's own
 * addresses (`bot-agents`, `bots/{botId}/delegation`). Every request is recorded; one anywhere else
 * is refused, so a hand-written fetch or another address cannot pass.
 */

const ORG = "/api/v2/organizations/default";

const OPENBOT: BotAgent = {
  id: "bag_openbot",
  name: "OpenBot",
  description: "OpenBot's own agent.",
  kind: "openbot",
  visibility: "public",
  endpoint: null,
  framework: "OpenBot",
  model: null,
  skills: [],
  hasAuth: false,
  hasCallbackToken: false,
  builtIn: true,
  canManage: false,
  mine: false,
  botCount: 3,
  createdAt: "2026-11-16T09:00:00Z",
  updatedAt: "2026-11-16T09:00:00Z",
};

const ANALYST: BotAgent = {
  ...OPENBOT,
  id: "bag_analyst",
  name: "Pipeline analyst",
  description: "Reads the pipeline and forecasts the quarter.",
  kind: "address",
  visibility: "private",
  endpoint: "https://agents.example.com/ag-ui",
  framework: "LangChain",
  builtIn: false,
  canManage: true,
  mine: true,
  botCount: 1,
};

let delegation: Delegation;
type Seen = { line: string; body: unknown };
const seen: Seen[] = [];

const server = setupServer(
  http.get(`*${ORG}/bot-agents`, () =>
    HttpResponse.json({ agents: [OPENBOT, ANALYST], nextCursor: null }),
  ),
  http.delete(`*${ORG}/bot-agents/:id`, () =>
    HttpResponse.json(
      {
        type: "https://open.bot/errors/bot-agent-in-use",
        title: "A Bot runs on this agent alone.",
        status: 409,
        detail:
          "1 Bot runs on this agent alone. Give it another agent first, then delete this one.",
        code: "BOT_AGENT_IN_USE",
        category: "conflict",
        retryable: false,
        requestId: "req",
        traceId: "trace",
      },
      {
        status: 409,
        headers: { "Content-Type": "application/problem+json" },
      },
    ),
  ),
  http.get(`*${ORG}/bots/:botId/delegation`, () =>
    HttpResponse.json(delegation),
  ),
  http.put(`*${ORG}/bots/:botId/delegation`, async ({ request }) => {
    const body = (await request.json()) as {
      mode: Delegation["mode"];
      agentIds: string[];
    };
    delegation = {
      ...delegation,
      mode: body.mode,
      agents: body.agentIds.map((id) => ({
        ...(id === ANALYST.id ? ANALYST : OPENBOT),
        available: true,
      })),
    };
    return HttpResponse.json(delegation);
  }),
  http.get(`*${ORG}/model-catalogue`, () =>
    HttpResponse.json({
      provider: "openai",
      source: "openai",
      exposure: "allowed",
      default: "gpt-x",
      models: [{ id: "gpt-x", label: "GPT X" }],
      choosable: true,
      listed: true,
    }),
  ),
  http.all("*", () => new HttpResponse(null, { status: 404 })),
);
server.events.on("request:start", async ({ request }) => {
  const url = new URL(request.url);
  const body =
    request.method === "PUT" ? await request.clone().json() : undefined;
  seen.push({ line: `${request.method} ${url.pathname}`, body });
});

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://openbot.invalid/" });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  server.resetHandlers();
  seen.length = 0;
});
afterAll(async () => {
  server.close();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const draw = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );

/** The route's guard, as the router runs it before the page. */
const guard = AgentsRoute.options.beforeLoad as unknown as (input: {
  search: Record<string, unknown>;
}) => unknown;

test("/agents on its own is the Agents page, and the old links still lead to the Bots", () => {
  expect(guard({ search: {} })).toBeUndefined();
  for (const [search, to] of [
    [{ new: true }, "/bots"],
    [{ agent: "agent_1" }, "/bots/$agentId"],
  ] as const) {
    try {
      guard({ search });
      throw new Error("No redirect");
    } catch (thrown) {
      expect(isRedirect(thrown)).toBe(true);
      expect((thrown as { options: { to: string } }).options.to).toBe(to);
    }
  }
});

test("the list says where each agent runs and how many Bots use it, and a refused delete shows the server's sentence", async () => {
  const user = userEvent.setup({ document });
  const view = draw(<AgentList onAdd={() => {}} onEdit={() => {}} />);

  await view.findByText("Pipeline analyst");
  expect(view.getByText("Runs in OpenBot")).toBeTruthy();
  expect(view.getByText("LangChain at agents.example.com")).toBeTruthy();
  expect(view.getByText("Used by 3 Bots")).toBeTruthy();
  expect(view.getByText("Used by 1 Bot")).toBeTruthy();
  expect(view.getAllByText("Private")).toHaveLength(1);
  // Only the agent the person may manage has a menu.
  expect(view.queryByRole("button", { name: "More for OpenBot" })).toBeNull();

  await user.click(
    view.getByRole("button", { name: "More for Pipeline analyst" }),
  );
  await user.click(
    await view.findByRole("menuitem", { name: "Delete Pipeline analyst" }),
  );
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "1 Bot runs on this agent alone. Give it another agent first, then delete this one.",
  );
  expect(seen.map((each) => each.line)).toEqual([
    `GET ${ORG}/bot-agents`,
    `DELETE ${ORG}/bot-agents/bag_analyst`,
  ]);
});

const BOT = { id: "agent_sales" } as AgentProfile;

test("the Hand work to agents switch saves on its own, keeping the agent the Bot ran on as its default, and the agents ticked after it save with Save", async () => {
  delegation = {
    botId: BOT.id,
    mode: "self",
    model: null,
    effort: null,
    instructions: "",
    agents: [{ ...OPENBOT, available: true }],
    canManage: true,
  };
  const user = userEvent.setup({ document });
  const view = draw(<BotDelegation agent={BOT} />);
  const puts = () => seen.filter((each) => each.line.startsWith("PUT"));

  const toggle = await view.findByRole("switch", {
    name: "Hand work to agents",
  });
  expect(
    view.getByText("This Bot does the work itself, with its apps."),
  ).toBeTruthy();
  await user.click(toggle);
  // Saved at once, with no Save pressed: the agent it ran on, now its default.
  await waitFor(() => expect(puts()).toHaveLength(1));
  expect(puts()[0]?.line).toBe(`PUT ${ORG}/bots/agent_sales/delegation`);
  expect(puts()[0]?.body).toEqual({
    mode: "orchestrate",
    model: null,
    effort: null,
    instructions: "",
    agentIds: ["bag_openbot"],
  });

  const list = await view.findByRole("list", { name: "Agents it may use" });
  expect(within(list).getByText("Default")).toBeTruthy();
  await user.click(
    within(list).getByRole("checkbox", { name: /Pipeline analyst/ }),
  );
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(puts()).toHaveLength(2));
  expect(puts()[1]?.body).toEqual({
    mode: "orchestrate",
    model: null,
    effort: null,
    instructions: "",
    agentIds: ["bag_openbot", "bag_analyst"],
  });
});

test("an agent private to somebody else reads as such, and the Bot's manager can take it off", async () => {
  delegation = {
    botId: BOT.id,
    mode: "orchestrate",
    model: null,
    effort: null,
    instructions: "",
    agents: [
      { ...OPENBOT, available: true },
      {
        id: "bag_hidden",
        name: "Private agent",
        description: "",
        kind: "address",
        available: false,
      },
    ],
    canManage: true,
  };
  const user = userEvent.setup({ document });
  const view = draw(<BotDelegation agent={BOT} />);

  const list = await view.findByRole("list", { name: "Agents it may use" });
  expect(within(list).getByText("Somebody else's private agent.")).toBeTruthy();
  expect(within(list).getByText("Unavailable")).toBeTruthy();
  await user.click(
    within(list).getByRole("checkbox", { name: /Private agent/ }),
  );
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(seen.some((each) => each.line.startsWith("PUT"))).toBe(true),
  );
  const put = seen.find((each) => each.line.startsWith("PUT"));
  expect((put?.body as { agentIds?: string[] } | undefined)?.agentIds).toEqual([
    "bag_openbot",
  ]);
});

/*
 * FOUND IN THE BIG TEST: Save on a Bot's Agents page said nothing. The form is drawn again from what
 * was saved once the page reads the Bot again, and that took "Saved." with it.
 */
test("Save says Saved., and still says it once the page has read the Bot again", async () => {
  delegation = {
    botId: BOT.id,
    mode: "self",
    model: null,
    effort: null,
    instructions: "",
    agents: [{ ...OPENBOT, available: true }],
    canManage: true,
  };
  const user = userEvent.setup({ document });
  const view = draw(<BotDelegation agent={BOT} />);
  const reads = () =>
    seen.filter(
      (each) => each.line === `GET ${ORG}/bots/agent_sales/delegation`,
    ).length;

  await user.click(
    await view.findByRole("button", { name: /Pipeline analyst/ }),
  );
  await user.click(view.getByRole("button", { name: "Save" }));
  // The save, then the page reading the Bot again with the agent it now runs on.
  await waitFor(() => expect(reads()).toBe(2));
  await waitFor(() =>
    expect(
      view
        .getByRole("button", { name: /Pipeline analyst/ })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect((await view.findByRole("status")).textContent).toBe("Saved.");
});

/*
 * Chosen while David was away (2026-11-16): how a Bot hands out work is its owner's own words, which
 * can name an agent private to them. Somebody the Bot is shared with sees the agents, by the names
 * they may see, and not the words.
 */
test("somebody who can't change the Bot doesn't see how it hands out work", async () => {
  delegation = {
    botId: BOT.id,
    mode: "orchestrate",
    model: null,
    effort: null,
    instructions: "",
    agents: [
      { ...OPENBOT, available: true },
      {
        id: "bag_hidden",
        name: "Private agent",
        description: "",
        kind: "openbot",
        available: true,
      },
    ],
    canManage: false,
  };
  const view = draw(<BotDelegation agent={BOT} />);
  const list = await view.findByRole("list", { name: "Agents it may use" });
  expect(within(list).getByText("Somebody else's private agent.")).toBeTruthy();
  expect(view.queryAllByText(/How it hands out work/)).toHaveLength(0);
  expect(view.queryByRole("textbox")).toBeNull();
  expect(view.queryByRole("button", { name: "Save" })).toBeNull();
});
