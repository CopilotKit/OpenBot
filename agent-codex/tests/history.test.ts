import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { toCodexTurnInput } from "../src/history";

const input = (messages: unknown[]): RunAgentInput =>
  ({ messages }) as RunAgentInput;

describe("toCodexTurnInput", () => {
  test("uses the latest user message and carries the standing role", () => {
    const result = toCodexTurnInput(
      input([
        { role: "system", content: "You are the finance coworker." },
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Follow-up question" },
      ]),
    );

    expect(result.prompt).toBe("Follow-up question");
    expect(result.developerInstructions).toContain(
      "You are the finance coworker.",
    );
    expect(result.developerInstructions).toContain("Respond with text only");
  });

  test("refuses an empty turn", () => {
    expect(() =>
      toCodexTurnInput(input([{ role: "system", content: "A role" }])),
    ).toThrow("needs a user message");
  });
});
