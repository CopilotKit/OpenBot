import { expect, test } from "bun:test";
import { createKnowledgeAgent } from "../src/agents/knowledge-agent";

test("returns authorized knowledge citations to the model port", async () => {
  const agent = createKnowledgeAgent({
    available: true,
    search: async () => [
      {
        title: "Policy",
        canonicalUrl: "https://example.test/policy",
        content: "Use MFA.",
      },
    ],
    complete: async ({ context }) => `Answer: ${context[0]?.content}`,
  });
  await expect(agent.respond("What is required?")).resolves.toEqual({
    text: "Answer: Use MFA.",
    citations: [
      {
        title: "Policy",
        canonicalUrl: "https://example.test/policy",
        content: "Use MFA.",
      },
    ],
  });
});

test("refuses to run when its model credential is unavailable", async () => {
  const agent = createKnowledgeAgent({
    available: false,
    search: async () => [],
    complete: async () => "unused",
  });
  await expect(agent.respond("question")).rejects.toThrow(
    "Model credential is not configured.",
  );
});
