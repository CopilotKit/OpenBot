import { expect, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import { Route as AgentsRoute } from "@/routes/_authed/_app/agents/index";
import { Route as BotAgentsRoute } from "@/routes/_authed/_app/bots.$agentId.agents";

/*
 * OpenBot has no Agents pages: a person has Bots, and a Bot's model is all they choose. The old
 * addresses still lead somewhere: `/agents` to the Bots, its old links to New Bot and to a Bot's
 * page, and a Bot's own Agents address to that Bot's page.
 */

type Redirected = {
  options: { to: string; params?: { agentId: string }; search?: unknown };
};

function target(run: () => unknown): Redirected["options"] {
  try {
    run();
  } catch (thrown) {
    expect(isRedirect(thrown)).toBe(true);
    return (thrown as Redirected).options;
  }
  throw new Error("No redirect");
}

const agents = AgentsRoute.options.beforeLoad as unknown as (match: {
  search: Record<string, unknown>;
}) => unknown;
const botAgents = BotAgentsRoute.options.beforeLoad as unknown as (match: {
  params: { agentId: string };
}) => unknown;

test("/agents goes to the Bots, and its old links to New Bot and to a Bot's page", () => {
  expect(target(() => agents({ search: {} })).to).toBe("/bots");
  const created = target(() => agents({ search: { new: true } }));
  expect(created.to).toBe("/bots");
  expect(created.search).toEqual({ new: true });
  const opened = target(() => agents({ search: { agent: "agent_1" } }));
  expect(opened.to).toBe("/bots/$agentId");
  expect(opened.params).toEqual({ agentId: "agent_1" });
});

test("a Bot's Agents address goes to the Bot's page", () => {
  const options = target(() => botAgents({ params: { agentId: "agent_1" } }));
  expect(options.to).toBe("/bots/$agentId");
  expect(options.params).toEqual({ agentId: "agent_1" });
});
