import { expect, test } from "bun:test";
import {
  AGENT_ORB_AT_REST,
  AGENT_ORB_LISTENING,
} from "@openbot/shared/agent-orb";
import { getAIStateMotion } from "../src/components/agents/orb/ai-core";

/*
 * The Desktop setup window draws `AgentOrb`'s disc from `shared/agent-orb` without the app's
 * states: at rest, and for a moment as if listening when it is clicked. Those are the app's `idle`
 * and `listening`: if either changes, the setup window's mark follows it.
 */
test("the orb at rest and listening are the app's idle and listening", () => {
  for (const [mood, state] of [
    [AGENT_ORB_AT_REST, "idle"],
    [AGENT_ORB_LISTENING, "listening"],
  ] as const) {
    const { glow, saturation, scale, speed } = getAIStateMotion(state);
    expect(mood).toEqual({ glow, saturation, scale, speed });
  }
});
