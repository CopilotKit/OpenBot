import { describe, expect, test } from "bun:test";
import {
  botOfCall,
  channelAgentId,
  declaredBotId,
} from "../src/lib/copilot/active-bot";

/**
 * The placeholder Bot id is a routing convenience, not a Bot. Anything that would ask the server
 * about it must be told there is nothing to ask about.
 */

describe("declaredBotId", () => {
  test("returns undefined for the placeholder", () => {
    expect(declaredBotId("default")).toBeUndefined();
  });

  test("passes a declared Bot through", () => {
    expect(declaredBotId("general-assistant")).toBe("general-assistant");
  });

  test("passes a Bot through even when the placeholder is its prefix", () => {
    expect(declaredBotId("default-2")).toBe("default-2");
  });
});

/**
 * A tool call acts for the Bot that made it, which is not always the Bot on screen: a turn carries
 * on after its person leaves the conversation. These are the agents the SDK hands a handler, as the
 * app makes them.
 */
describe("botOfCall", () => {
  test("a channel's call is its Bot's, whatever is on screen", () => {
    const agent = {
      agentId: channelAgentId("c1"),
      runtimeAgentId: "crm-bot",
    };
    expect(botOfCall(agent, "default")).toBe("crm-bot");
    expect(botOfCall(agent, "other-bot")).toBe("crm-bot");
  });

  test("a call from a Bot's own page is that Bot's", () => {
    expect(botOfCall({ agentId: "crm-bot" }, "other-bot")).toBe("crm-bot");
  });

  test("a channel's local id is never taken for a Bot", () => {
    expect(botOfCall({ agentId: channelAgentId("c1") }, "crm-bot")).toBe(
      "crm-bot",
    );
  });

  test("an agent named for the placeholder is not taken for a Bot", () => {
    expect(botOfCall({ agentId: "default" }, "crm-bot")).toBe("crm-bot");
  });

  test("a call with no agent, through WebMCP, is the screen's", () => {
    expect(botOfCall(undefined, "crm-bot")).toBe("crm-bot");
  });
});
