import { describe, expect, test } from "bun:test";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { AuditInitiator } from "../src/audit";

describe("actor-scoped agent resolver", () => {
  test("builds only the addressed coworker and carries the headless initiator and depth", async () => {
    const built: string[] = [];
    const contexts: unknown[] = [];
    const actor = { id: "u1", role: "admin" as const };
    const initiator: AuditInitiator = { kind: "routine", id: "routine-1" };
    const resolver = createActorAgentResolver({
      loadAgents: async (seenActor) => {
        expect(seenActor).toEqual(actor);
        return ["risk", "other"].map((id) => ({
          id,
          name: id,
          type: "built_in" as const,
          systemPrompt: "Work.",
        }));
      },
      model: { provider: "openai", defaultModel: "unused" },
      resolveModelApiKey: async () => "synthetic-key",
      loadToolsForActor: (id, cause) => {
        contexts.push(["tools", id, cause]);
        return async (botId) => {
          built.push(botId);
          return [];
        };
      },
      signRunForActor: (id, cause, depth) => {
        contexts.push(["sign", id, cause, depth]);
        return () => "synthetic-assertion";
      },
      handoffForActor: (id, cause, depth) => {
        contexts.push(["handoff", id, cause, depth]);
        return async () => [];
      },
      loadInstructionsForActor: (id) => async () => {
        contexts.push(["instructions", id]);
        return "Be precise.";
      },
    });
    await resolver.resolveAgentForActor(actor, "risk", { initiator, depth: 3 });
    expect(built).toEqual(["risk"]);
    expect(contexts).toEqual([
      ["tools", "u1", initiator],
      ["sign", "u1", initiator, 3],
      ["handoff", "u1", initiator, 3],
      ["instructions", "u1"],
    ]);
  });

  test("propagates construction failures instead of reporting an unavailable coworker", async () => {
    const failure = new Error("key store unavailable");
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        { id: "risk", name: "Risk", type: "built_in", systemPrompt: "Work." },
      ],
      model: { provider: "openai", defaultModel: "unused" },
      resolveModelApiKey: async () => {
        throw failure;
      },
    });
    await expect(
      resolver.resolveAgentForActor({ id: "u1", role: "user" }, "risk"),
    ).rejects.toBe(failure);
  });

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
