// server/tests/tool-budget.test.ts
import { describe, expect, test } from "bun:test";
import { MODEL_TOOL_LIMIT } from "@openbot/shared/model-tool-limit";
import {
  BUILT_IN_TOOL_ALLOWANCE,
  GRANTED_TOOL_BUDGET,
  toolBudgetRefusal,
} from "../src/plugins/tool-budget";

/**
 * How many tools one approval may leave a Bot granted. The routes ask this before granting
 * anything; `app-access-routes.integration.test.ts` covers that they do.
 */
describe("how many tools a Bot may be granted", () => {
  test("the budget leaves room in every request for the tools a Bot carries anyway", () => {
    expect(MODEL_TOOL_LIMIT).toBe(128);
    expect(GRANTED_TOOL_BUDGET).toBe(
      MODEL_TOOL_LIMIT - BUILT_IN_TOOL_ALLOWANCE,
    );
    expect(GRANTED_TOOL_BUDGET).toBeGreaterThan(0);
  });

  test("up to the budget fits", () => {
    expect(toolBudgetRefusal({ app: "Gmail", adding: 12, holding: 0 })).toBe(
      null,
    );
    expect(
      toolBudgetRefusal({
        app: "Gmail",
        adding: 10,
        holding: GRANTED_TOOL_BUDGET - 10,
      }),
    ).toBe(null);
  });

  test("one past it is refused, counting what the Bot already holds", () => {
    expect(
      toolBudgetRefusal({
        app: "Gmail",
        adding: 11,
        holding: GRANTED_TOOL_BUDGET - 10,
      }),
    ).not.toBe(null);
  });

  test("the refusal names the app, what it adds, the total and the limits", () => {
    expect(toolBudgetRefusal({ app: "Shopify", adding: 239, holding: 3 })).toBe(
      `This would give the Bot 239 of Shopify's tools, 242 granted in all, and a Bot can be granted at most ${GRANTED_TOOL_BUDGET}: a model takes at most ${MODEL_TOOL_LIMIT} tools in one request, and the Bot needs the rest for its own.`,
    );
  });
});
