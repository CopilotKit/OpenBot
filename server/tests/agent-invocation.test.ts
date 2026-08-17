import { expect, test } from "bun:test";
import { createAgentInvoker } from "../src/agents/invocation";

test("invokes the selected available built-in agent", async () => {
  const invoke = createAgentInvoker({
    knowledge: async () => ({ text: "Answer", citations: [] }),
    remote: async () => ({ text: "unused", citations: [] }),
  });
  await expect(
    invoke({ id: "knowledge", type: "built_in", available: true }, "question"),
  ).resolves.toEqual({ text: "Answer", citations: [] });
});

test("rejects unavailable agents before invocation", async () => {
  const invoke = createAgentInvoker({
    knowledge: async () => ({ text: "unused", citations: [] }),
    remote: async () => ({ text: "unused", citations: [] }),
  });
  await expect(
    invoke(
      {
        id: "knowledge",
        type: "built_in",
        available: false,
        reason: "Model credential is not configured.",
      },
      "question",
    ),
  ).rejects.toThrow("Model credential is not configured.");
});
