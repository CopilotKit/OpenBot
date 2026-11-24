import { expect, test } from "bun:test";
import { AGENT_ORB_AT_REST } from "@openbot/shared/agent-orb";
import { getAIStateMotion } from "../src/components/agents/orb/ai-core";

/*
 * The Desktop setup window draws `AgentOrb`'s disc from `shared/agent-orb` without the app's
 * states, at rest. Rest is the app's `idle`: if `idle` changes, the setup window's mark follows it.
 */
test("the orb at rest is the app's idle orb", () => {
  const idle = getAIStateMotion("idle");
  expect(AGENT_ORB_AT_REST).toEqual({
    saturation: idle.saturation,
    speed: idle.speed,
  });
});
