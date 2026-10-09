import { expect, test } from "bun:test";
import { LEGACY_PAGES, legacyAgentsTarget } from "@/lib/agents/legacy-routes";

test("/agents?agent=<id> opens that Bot's page", () => {
  expect(legacyAgentsTarget({ agent: "agent_1" })).toEqual({
    to: "/bots/$agentId",
    params: { agentId: "agent_1" },
    replace: true,
  });
});

test("/agents?new=true opens the new-Bot wizard on the roster", () => {
  expect(legacyAgentsTarget({ new: true })).toEqual({
    to: "/bots",
    search: { new: true },
    replace: true,
  });
});

test("/agents on its own is the roster", () => {
  expect(legacyAgentsTarget({})).toEqual({ to: "/bots", replace: true });
});

test("creating wins over opening, as it did on /agents", () => {
  expect(legacyAgentsTarget({ new: true, agent: "agent_1" }).to).toBe("/bots");
});

test("the four pages that left the sidebar send people to where their contents went", () => {
  expect(LEGACY_PAGES).toEqual({
    "/approvals": "/settings/approvals",
    "/memory": "/settings/memory",
    "/reachability": "/settings/notifications",
    "/responsibilities": "/bots",
  });
});
