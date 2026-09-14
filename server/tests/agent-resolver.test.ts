import { describe, expect, test } from "bun:test";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { createActorAgentResolver } from "../src/agents/agent-resolver";

describe("actor-scoped agent resolver", () => {
  test("uses the same actor for web maps and individual agent resolution", async () => {
    const seenActorIds: string[] = [];
    const resolver = createActorAgentResolver({
      loadAgents: async (actor) => {
        seenActorIds.push(actor.id);
        return [
          {
            id: "risk",
            name: "Risk Analyst",
            type: "built_in" as const,
            systemPrompt: "Assess operational risk.",
          },
        ];
      },
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => "openai-secret",
    });
    const actor = { id: "u1", role: "user" as const };

    const visibleAgents = await resolver.resolveAgentsForActor(actor);
    const risk = await resolver.resolveAgentForActor(actor, "risk");

    expect(seenActorIds).toEqual(["u1", "u1"]);
    expect(visibleAgents.risk).toBeInstanceOf(BuiltInAgent);
    expect(risk).toBeInstanceOf(BuiltInAgent);
  });

  test("rejects an agent absent from the actor's visible map", async () => {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: "risk",
          name: "Risk Analyst",
          type: "built_in" as const,
          systemPrompt: "Assess operational risk.",
        },
      ],
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => "openai-secret",
    });

    let rejection: unknown;
    try {
      await resolver.resolveAgentForActor(
        { id: "u1", role: "user" },
        "private-risk",
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(
      "Coworker private-risk is unavailable to this user.",
    );
  });

  test("rejects an agent when the actor has no visible coworkers", async () => {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [],
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => "openai-secret",
    });

    expect(
      await rejectionMessage(() =>
        resolver.resolveAgentForActor(
          { id: "u1", role: "user" },
          "private-risk",
        ),
      ),
    ).toBe("Coworker private-risk is unavailable to this user.");
  });

  test("rejects inherited object keys as unavailable coworkers", async () => {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: "risk",
          name: "Risk Analyst",
          type: "built_in" as const,
          systemPrompt: "Assess operational risk.",
        },
      ],
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => "openai-secret",
    });

    for (const agentId of ["constructor", "toString", "__proto__"]) {
      expect(
        await rejectionMessage(() =>
          resolver.resolveAgentForActor({ id: "u1", role: "user" }, agentId),
        ),
      ).toBe(`Coworker ${agentId} is unavailable to this user.`);
    }
  });
});

async function rejectionMessage(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected the run to reject.");
}
