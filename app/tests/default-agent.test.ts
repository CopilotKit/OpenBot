import { describe, expect, test } from "bun:test";
import {
  defaultAgentId,
  defaultAgentProfile,
  PICKED_HARNESS_AGENT_ID,
} from "@/lib/agents/default-agent";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * A Bot as the API lists it. `packageBotId` is which of the Bots OpenBot starts with it is: the
 * Bot's own id in the first organization, the package's id on another organization's copy (whose
 * own id is generated), and null for a Bot somebody made.
 */
function agent(
  id: string,
  name = id,
  packageBotId: string | null = id === PICKED_HARNESS_AGENT_ID ? id : null,
): AgentProfile {
  return {
    packageBotId,
    assignedToMe: false,
    runsOnOpenBotModel: false,
    keyFromOpenBot: false,
    avatarSeed: id,
    builtIn: id === "general-assistant",
    canManage: true,
    endpoint: id === PICKED_HARNESS_AGENT_ID ? "http://127.0.0.1:4201" : null,
    hasAuth: false,
    hasCallbackToken: false,
    isolated: false,
    isolationActive: false,
    isolationOffReason: null,
    hidden: false,
    pinned: false,
    id,
    mine: true,
    name,
    roleDescription: "Role",
    systemOwned: false,
    title: name,
    visibility: "private",
  };
}

describe("default agent selection", () => {
  test("prefers the picked harness over the first visible agent", () => {
    const chosen = defaultAgentProfile([
      agent("general-assistant", "General Assistant"),
      agent(PICKED_HARNESS_AGENT_ID, "LangGraph"),
    ]);

    expect(chosen?.id).toBe(PICKED_HARNESS_AGENT_ID);
    expect(
      defaultAgentId([
        agent("general-assistant"),
        agent(PICKED_HARNESS_AGENT_ID),
      ]),
    ).toBe(PICKED_HARNESS_AGENT_ID);
  });

  test("prefers a new organization's copy of the picked harness, whose id is generated", () => {
    const roster = [
      agent("bot_4f1c2a", "General Assistant", "general-assistant"),
      agent("bot_9c2e7d", "LangGraph", PICKED_HARNESS_AGENT_ID),
      agent("bot_made", "Somebody's Bot"),
    ];

    expect(defaultAgentProfile(roster)?.id).toBe("bot_9c2e7d");
    expect(defaultAgentId(roster)).toBe("bot_9c2e7d");
  });

  test("a Bot somebody made is not the picked harness, whatever its id", () => {
    const made = agent(PICKED_HARNESS_AGENT_ID, "Somebody's Bot", null);

    expect(
      defaultAgentId([agent("bot_4f1c2a", "General Assistant"), made]),
    ).toBe("bot_4f1c2a");
  });

  test("keeps the route-specific fallback when there is no picked harness", () => {
    const general = agent("general-assistant", "General Assistant");
    const shared = agent("shared-agent", "Shared Agent");

    expect(defaultAgentProfile([general, shared], shared)?.id).toBe(
      "shared-agent",
    );
  });

  test("falls back to the first agent when no picked harness or route fallback exists", () => {
    expect(
      defaultAgentId([agent("general-assistant"), agent("researcher")]),
    ).toBe("general-assistant");
  });

  test("returns undefined when the roster is still absent", () => {
    expect(defaultAgentId(undefined)).toBeUndefined();
  });
});
