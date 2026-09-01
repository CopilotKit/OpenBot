import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { recoveredThreadPrompt, toCodexTurnInput } from "../src/history";

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
    expect(result.developerInstructions).toContain("OpenBot dynamic tools");
    expect(result.developerInstructions).toContain("Never run shell commands");
  });

  test("refuses an empty turn", () => {
    expect(() =>
      toCodexTurnInput(input([{ role: "system", content: "A role" }])),
    ).toThrow("needs a user message");
  });

  test("replays prior conversation without duplicating the current request", () => {
    const run = input([
      { role: "system", content: "A standing role" },
      { role: "user", content: "Remember codeword cobalt" },
      { role: "assistant", content: "I will remember cobalt" },
      { role: "user", content: "What is the codeword?" },
    ]);

    const prompt = recoveredThreadPrompt(run, "What is the codeword?");
    expect(prompt).toContain("Remember codeword cobalt");
    expect(prompt).toContain("I will remember cobalt");
    expect(prompt.match(/What is the codeword\?/g)).toHaveLength(1);
    expect(prompt).not.toContain("A standing role");
  });
});
