import { describe, expect, test } from "bun:test";
import { REASONING_EFFORTS, readReasoningEffort } from "../src/model-options";

/**
 * Reasoning effort, checked where a deployment can still be fixed.
 *
 * The complaint in #212 is that invalid configuration is worse than absent configuration: a value
 * the API does not know is dropped somewhere down the stack, the Bot starts, looks healthy, and
 * thinks for as long as it likes. So an effort this build has not heard of is a refusal at startup,
 * in front of whoever is deploying, the same posture as a missing model key.
 */
describe("reasoning effort from the environment", () => {
  test("unset asks for nothing, so the model keeps its own default", () => {
    expect(readReasoningEffort(undefined)).toEqual({ effort: undefined });
    expect(readReasoningEffort("")).toEqual({ effort: undefined });
    expect(readReasoningEffort("   ")).toEqual({ effort: undefined });
  });

  test("accepts every effort the installed API knows", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(readReasoningEffort(effort)).toEqual({ effort });
    }
  });

  test("takes the value as written in a compose file", () => {
    // Surrounding space and a capital are how this arrives from YAML, not a different setting.
    expect(readReasoningEffort(" High ")).toEqual({ effort: "high" });
  });

  test("refuses an effort the API does not have, and names the ones it does", () => {
    const result = readReasoningEffort("maximum");
    expect(result.effort).toBeUndefined();
    expect(result.problem).toContain("maximum");
    for (const effort of REASONING_EFFORTS) {
      expect(result.problem).toContain(effort);
    }
  });

  test("refuses a number, which is what a first guess at this setting looks like", () => {
    expect(readReasoningEffort("3").problem).toBeDefined();
  });
});
