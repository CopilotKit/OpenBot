import { describe, expect, test } from "bun:test";
import { declaredBotId } from "../src/lib/copilot/active-bot";

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
