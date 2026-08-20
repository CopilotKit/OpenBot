import { describe, expect, test } from "bun:test";
import { hasManagedAgentToken, matchesToken } from "./agent-authorisation";

describe("managed agent authorization", () => {
  test("accepts only the configured token", () => {
    const expected = "agent-bot-secret";

    expect(
      hasManagedAgentToken(
        new Request("http://bot.local/ag-ui", {
          headers: { "x-openbot-agent-token": expected },
        }),
        expected,
      ),
    ).toBe(true);
    expect(
      hasManagedAgentToken(new Request("http://bot.local/ag-ui"), expected),
    ).toBe(false);
    expect(
      hasManagedAgentToken(
        new Request("http://bot.local/ag-ui", {
          headers: { "x-openbot-agent-token": "wrong" },
        }),
        expected,
      ),
    ).toBe(false);
  });

  test("rejects empty and differently sized tokens", () => {
    expect(matchesToken("", "")).toBe(false);
    expect(matchesToken("expected", "short")).toBe(false);
  });
});
