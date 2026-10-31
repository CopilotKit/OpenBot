import { describe, expect, spyOn, test } from "bun:test";
import { AbstractAgent, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { EMPTY } from "rxjs";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type { AuditInitiator } from "../src/audit";
import { standingRoleMessage } from "../src/copilot";
import {
  NameContextMiddleware,
  PROFILE_CONTEXT,
} from "../src/people/name-context";

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

test("profile context is attached only to built-in agents for web and individual resolution", async () => {
  const use = spyOn(AbstractAgent.prototype, "use");
  try {
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        { id: "local", name: "Local", type: "built_in", systemPrompt: "Help." },
        {
          id: "custom",
          name: "Custom",
          type: "remote_ag_ui",
          endpoint: "https://custom.test/ag-ui",
          standingMessage: standingRoleMessage({
            id: "custom",
            name: "Custom",
            roleDescription: "Help with tasks.",
            title: "Custom agent",
          }),
        },
      ],
      model: { provider: "openai", defaultModel: "unused" },
      resolveModelApiKey: async () => "synthetic-key",
      loadNameForActor: async () => "Sam",
    });
    const actor = { id: "person", role: "user" as const };
    await resolver.resolveAgentsForActor(actor);
    expect(
      use.mock.calls.filter((call) =>
        call.some((middleware) => middleware instanceof NameContextMiddleware),
      ),
    ).toHaveLength(1);
    use.mockClear();
    await resolver.resolveAgentForActor(actor, "custom");
    expect(
      use.mock.calls
        .flat()
        .some((middleware) => middleware instanceof NameContextMiddleware),
    ).toBe(false);
    use.mockClear();
    await resolver.resolveAgentForActor(actor, "local");
    expect(
      use.mock.calls
        .flat()
        .filter((middleware) => middleware instanceof NameContextMiddleware),
    ).toHaveLength(1);
  } finally {
    use.mockRestore();
  }
});

test("runs carry the name only to built-in agents, including cloned agents", async () => {
  const captured: RunAgentInput[] = [];
  const capture = (input: RunAgentInput) => {
    captured.push(input);
    return EMPTY;
  };
  const builtIn = spyOn(BuiltInAgent.prototype, "run").mockImplementation(
    capture,
  );
  const remote = spyOn(HttpAgent.prototype, "run").mockImplementation(capture);
  const reads: string[] = [];
  try {
    const custom = {
      id: "custom",
      name: "Custom",
      type: "remote_ag_ui" as const,
      roleDescription: "Help with tasks.",
      title: "Custom agent",
    };
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        { id: "local", name: "Local", type: "built_in", systemPrompt: "Help." },
        {
          ...custom,
          endpoint: "https://custom.test/ag-ui",
          standingMessage: standingRoleMessage(custom),
        },
      ],
      model: { provider: "openai", defaultModel: "unused" },
      resolveModelApiKey: async () => "synthetic-key",
      loadNameForActor: async (id) => {
        reads.push(id);
        return "Sam";
      },
    });
    const actor = { id: "person", role: "user" as const };
    for (const agentId of ["local", "custom"]) {
      const agent = await resolver.resolveAgentForActor(actor, agentId);
      for (const instance of [agent, agent.clone()]) {
        instance.messages = [
          { id: "question", role: "user", content: "Hello" },
        ];
        await instance.runAgent();
      }
    }
    expect(captured).toHaveLength(4);
    for (const input of captured.slice(0, 2)) {
      expect(input.context).toContainEqual({
        description: PROFILE_CONTEXT,
        value: JSON.stringify({ name: "Sam" }),
      });
    }
    for (const input of captured.slice(2)) {
      expect(
        input.context.some((entry) => entry.description === PROFILE_CONTEXT),
      ).toBe(false);
    }
    expect(reads).toEqual(["person", "person"]);
  } finally {
    builtIn.mockRestore();
    remote.mockRestore();
  }
});
