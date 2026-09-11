import { describe, expect, spyOn, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import { HttpAgent } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { EMPTY } from "rxjs";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { MAX_INLINED_BYTES_PER_RUN } from "../src/channels/attachment-parts";
import { loadConfig } from "../src/config";
import type { LoadAttachment } from "../src/copilot";
import {
  buildAgents,
  builtInAgentConfiguration,
  createRequestAgents,
  type LoadInstructions,
  registeredAgentFromRow,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
  standingRoleMessage,
} from "../src/copilot";
import { grantedToolGuidance } from "../src/plugins/tools";
import { loadTenantPackage } from "../src/tenant-package";
import { testEnvironment } from "./support/environment";

/**
 * The Bot under test, or a failure that says it was never built.
 *
 * `agents["general-assistant"]?.run(...)` on an undefined agent never subscribes, so the promise
 * around that subscribe never settles and the test hangs to the suite's timeout with nothing in
 * the output naming the cause. A `buildAgents` that stopped returning this Bot is a failure to
 * report, not a five second wait. The optional-chaining form fails just as quietly without a
 * subscribe in play: `agent?.setMessages(...)` on an undefined agent is a no-op, and the assertions
 * after it then describe a Bot that was never run.
 *
 * AT MODULE SCOPE, not inside the describe that first needed it. Two describes reach for this — the
 * attachment one and the refused-conversation one — and while it lived in the first, the second
 * kept the `agent?.` shape it was written with, which is the whole failure above. A guard that has
 * to be copied to be used is a guard the next block will not have.
 */
function built(
  agents: Record<string, AbstractAgent>,
  id: string,
): AbstractAgent {
  const agent = agents[id];
  if (!agent) throw new Error(`buildAgents returned no "${id}" to run`);
  return agent;
}

// Every agent row now joins its profile, so the row a coworker is built from always names it.
const assistantRow = {
  id: "general-assistant",
  name: "General Assistant",
  type: "built_in" as const,
  title: "Everyday Work",
  roleDescription: "Help with everyday work.",
};
const riskRow = {
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui" as const,
  title: "Risk & Compliance",
  roleDescription: "Investigate policies and controls.",
};

type RemoteAgentProbe = {
  remote?: unknown;
  run?: unknown;
  clone?: unknown;
};

function expectWrappedHttpTransport(agent: unknown): HttpAgent {
  expect(agent).not.toBeInstanceOf(HttpAgent);
  expect(agent).toMatchObject({
    run: expect.any(Function),
    clone: expect.any(Function),
  });

  const transport = (agent as RemoteAgentProbe).remote;
  expect(transport).toBeInstanceOf(HttpAgent);
  return transport as HttpAgent;
}

describe("deployment model selection", () => {
  const packagePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../examples/fintech",
  );

  async function runGeneralAssistantWithEnvironment(
    environment: Record<string, string | undefined>,
  ) {
    const config = loadConfig({ ...testEnvironment(), ...environment });
    expect(config.runtime.mode).toBe("intelligence");
    const tenantPackage = await loadTenantPackage(packagePath);
    const model = runtimeModelForEnvironment(tenantPackage.model, environment);
    const recorder = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, {
        type: "text",
        content: "DEFAULTMODEL001 fixture completed.",
      });
      const agents = await resolveRuntimeAgents(
        () => [
          {
            id: "general-assistant",
            name: "General Assistant",
            type: "built_in" as const,
            systemPrompt: "Be helpful.",
          },
        ],
        model,
        async () => "synthetic-model-key",
      );
      const agent = agents["general-assistant"]?.clone();
      if (!agent) throw new Error("Expected General Assistant.");
      agent.addMessage({
        id: "defaultmodel001-request",
        role: "user",
        content: "Complete the fixture request.",
      });
      await agent.runAgent();
      expect(agent.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "DEFAULTMODEL001 fixture completed.",
      });
      expect(recorder.getRequests()).toHaveLength(1);
      return recorder.getRequests()[0]?.body as { model?: unknown };
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  }

  test("desktop-selected BOT_MODEL drives the built-in default agent model", async () => {
    const request = await runGeneralAssistantWithEnvironment({
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      BOT_MODEL: " selected-local-model ",
    });

    expect(request.model).toBe("selected-local-model");
  });

  test("explicit OpenAI provider still uses the OpenAI-compatible selected model", async () => {
    const request = await runGeneralAssistantWithEnvironment({
      BOT_PROVIDER: " openai ",
      OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
      BOT_MODEL: " selected-local-model ",
    });

    expect(request.model).toBe("selected-local-model");
  });

  test.each([
    {},
    { OPENAI_BASE_URL: "http://127.0.0.1:11434/v1", BOT_MODEL: "   " },
    { BOT_MODEL: "selected-local-model" },
    { BOT_PROVIDER: "anthropic", BOT_MODEL: "claude-sonnet-4-5" },
  ])(
    "package default remains the model without a compatible endpoint selection: %j",
    async (environment) => {
      const request = await runGeneralAssistantWithEnvironment(environment);

      expect(request.model).toBe("gpt-5.6-terra");
    },
  );
});

describe("registered Copilot agents", () => {
  test("normalizes built-in and remote rows", () => {
    expect(
      registeredAgentFromRow({
        ...assistantRow,
        configuration: { systemPrompt: "Be helpful." },
      }),
    ).toEqual({
      id: "general-assistant",
      name: "General Assistant",
      type: "built_in",
      systemPrompt: "Be helpful.",
    });
    expect(
      registeredAgentFromRow({
        ...riskRow,
        configuration: { endpoint: "http://risk.internal/ag-ui" },
      }),
    ).toEqual({
      id: "risk",
      name: "Risk",
      type: "remote_ag_ui",
      endpoint: "http://risk.internal/ag-ui",
      standingMessage: standingRoleMessage(riskRow),
    });
  });

  test("rejects malformed agent configurations", () => {
    const rows = [
      { ...assistantRow, configuration: {} },
      { ...assistantRow, configuration: null },
      { ...assistantRow, configuration: [] },
      { ...assistantRow, configuration: { systemPrompt: "   " } },
      { ...riskRow, configuration: { endpoint: "" } },
      { ...riskRow, configuration: { endpoint: "not a URL" } },
      { ...riskRow, configuration: { endpoint: "ftp://risk.internal/ag-ui" } },
    ] as const;

    for (const row of rows) {
      expect(registeredAgentFromRow(row)).toBeNull();
    }
  });

  test("trims built-in prompts and preserves valid remote endpoint strings", () => {
    expect(
      registeredAgentFromRow({
        ...assistantRow,
        configuration: { systemPrompt: "  Be helpful.  " },
      }),
    ).toMatchObject({ systemPrompt: "Be helpful." });
    expect(
      registeredAgentFromRow({
        ...riskRow,
        configuration: { endpoint: "https://risk.internal:443/ag-ui" },
      }),
    ).toMatchObject({ endpoint: "https://risk.internal:443/ag-ui" });
  });

  test("configures an OpenAI built-in agent", () => {
    expect(
      builtInAgentConfiguration(
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        { provider: "openai", defaultModel: "gpt-5.6-terra" },
        "openai-secret",
      ),
    ).toEqual({
      model: "openai/gpt-5.6-terra",
      // The provenance rule is unconditional, so even a Bot with no tools and no computer carries
      // it. That Bot needs it most: nothing it says was read anywhere.
      prompt: `Be helpful.\n\n${PROVENANCE_GUIDANCE}`,
      apiKey: "openai-secret",
    });
  });

  test("fails an unavailable built-in agent through the AG-UI lifecycle", async () => {
    const agents = await buildAgents(
      [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
      ],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      null,
    );
    const agent = agents["general-assistant"];
    if (!agent) {
      throw new Error("Expected the built-in agent");
    }
    let lifecycleError: Error | undefined;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        agent.runAgent(undefined, {
          onRunFailed: ({ error }) => {
            lifecycleError = error;
          },
        }),
      ).rejects.toThrow("Add the package credential or set OPENAI_API_KEY");
    } finally {
      consoleError.mockRestore();
    }
    expect(lifecycleError?.message).toContain(
      "Add the package credential or set OPENAI_API_KEY",
    );
  });

  test("constructs built-in and remote agents together", async () => {
    const agents = await buildAgents(
      [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      "openai-secret",
    );

    expect(agents["general-assistant"]).toBeInstanceOf(BuiltInAgent);
    expectWrappedHttpTransport(agents.risk);
  });

  /*
   * The watch goes on the fetch of a remote Bot and nowhere else.
   *
   * A built-in agent talks to a model provider through the AI SDK rather than over an AG-UI stream,
   * so there is no response body here to watch and nothing for the guard to be given. Asserting the
   * Bot's own name reaches it matters because that name is what the person is shown when its stream
   * goes quiet, and a guard handed the wrong one would say so convincingly.
   */
  test("hands a remote Bot's fetch to the stall guard, and a built-in Bot none", async () => {
    const watched: { id: string; name: string }[] = [];
    const stallGuard = {
      watch: (bot: { id: string; name: string }) => {
        watched.push(bot);
        return async () => new Response(null);
      },
      stop: () => undefined,
    };

    const agents = await buildAgents(
      [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      "openai-secret",
      stallGuard,
    );

    expect(watched).toEqual([{ id: "risk", name: "Risk" }]);
    expectWrappedHttpTransport(agents.risk);
  });

  /*
   * The dialling fetch reaches a remote Bot, through the guard and without one.
   *
   * Same sentinel trick as below, and for the same reason. This is the wiring that keeps the endpoint
   * check applied at run time: a registration is validated once, and every run afterwards dials that
   * address again, so the fetch that follows a redirect has to be the one that re-checks where it
   * goes.
   */
  test("dials a remote Bot with the fetch it was given, guarded or not", async () => {
    const dialler = async () => new Response(null);
    const registered = [
      {
        id: "risk",
        name: "Risk",
        type: "remote_ag_ui" as const,
        endpoint: "http://risk.internal/ag-ui",
      },
    ];
    const model = { provider: "openai" as const, defaultModel: "gpt-4.1" };

    const plain = (
      await buildAgents(
        registered,
        model,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        dialler,
      )
    ).risk;
    expect(expectWrappedHttpTransport(plain).fetch).toBe(dialler);

    // With a timeout configured the watch wraps it, so the guard is handed the dialling fetch rather
    // than replacing it. A deployment gets both, not whichever was wired last.
    let handed: unknown;
    const watched = (
      await buildAgents(
        registered,
        model,
        null,
        {
          watch: (_bot: { id: string; name: string }, inner?: unknown) => {
            handed = inner;
            return dialler;
          },
          stop: () => undefined,
        } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        dialler,
      )
    ).risk;
    expectWrappedHttpTransport(watched);
    expect(handed).toBe(dialler);
  });

  /*
   * The same fetch, but arriving the way the server actually builds agents.
   *
   * `buildAgents` is not what the runtime calls; `resolveRuntimeAgents` is, and it takes the fetch as
   * its own parameter. A parameter accepted and not forwarded looks identical from the outside to one
   * that works, and the run would quietly go back to the runtime's own fetch, which follows a
   * redirect anywhere.
   */
  test("carries the dialling fetch through resolveRuntimeAgents", async () => {
    const dialler = async () => new Response(null);
    const agents = await resolveRuntimeAgents(
      async () => [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui" as const,
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      { provider: "openai" as const, defaultModel: "gpt-4.1" },
      async () => null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      dialler,
    );

    const risk = agents.risk;
    expect(expectWrappedHttpTransport(risk).fetch).toBe(dialler);
  });

  /*
   * Told apart by a sentinel, because nothing else tells them apart.
   *
   * @ag-ui/client fills `fetch` in with a wrapper of its own whenever the config does not carry one,
   * so a remote Bot always has a function there and asserting that it does asserts nothing at all.
   * The same registration is built twice, with a guard whose watch returns a fetch nothing else
   * could have produced and then without one, and the two are compared.
   */
  test("leaves a remote Bot's fetch alone when no timeout is configured", async () => {
    const sentinel = async () => new Response(null);
    const registered = [
      {
        id: "risk",
        name: "Risk",
        type: "remote_ag_ui" as const,
        endpoint: "http://risk.internal/ag-ui",
      },
    ];
    const model = {
      provider: "openai" as const,
      defaultModel: "gpt-5.6-terra",
    };

    const guarded = (
      await buildAgents(registered, model, null, {
        watch: () => sentinel,
        stop: () => undefined,
      })
    ).risk;
    const unguarded = (await buildAgents(registered, model, null)).risk;

    expect(expectWrappedHttpTransport(guarded).fetch).toBe(sentinel);
    expect(expectWrappedHttpTransport(unguarded).fetch).not.toBe(sentinel);
  });

  test("resolves fresh built-in agents and credentials for every request", async () => {
    const registered = [
      {
        id: "general-assistant",
        name: "General Assistant",
        type: "built_in" as const,
        systemPrompt: "Be helpful.",
      },
    ];
    let resolutionCount = 0;
    const resolveModelApiKey = async () => {
      resolutionCount += 1;
      return resolutionCount === 1 ? "first-secret" : null;
    };

    const first = await resolveRuntimeAgents(
      async () => registered,
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey,
    );
    const second = await resolveRuntimeAgents(
      async () => registered,
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey,
    );

    expect(first["general-assistant"]).not.toBe(second["general-assistant"]);
    expect(resolutionCount).toBe(2);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(second["general-assistant"]?.runAgent()).rejects.toThrow(
        "Add the package credential or set OPENAI_API_KEY",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("does not resolve model credentials for remote-only agents", async () => {
    let resolverInvoked = false;
    const agents = await resolveRuntimeAgents(
      async () => [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      async () => {
        resolverInvoked = true;
        throw new Error("corrupt model credential");
      },
    );

    expectWrappedHttpTransport(agents.risk);
    expect(resolverInvoked).toBe(false);
  });
});

/**
 * A coworker's job is durable: it lives on the profile, not in the conversation. Every run of a
 * remote agent therefore carries a standing role message the person never has to retype, and the
 * runtime resolves which agents exist per request so one person's private coworker is not another's.
 */
describe("standing agent roles", () => {
  const profile = {
    id: "agent_expense",
    name: "Expense Manager",
    title: "Finance Operations",
    roleDescription:
      "Review receipts, categorize expenses, and prepare reimbursement reports.",
  };

  test("builds a stable, framework-neutral standing role message", () => {
    expect(standingRoleMessage(profile)).toEqual({
      id: "standing-role:agent_expense",
      role: "system",
      content: [
        "You are Expense Manager, Finance Operations.",
        "Review receipts, categorize expenses, and prepare reimbursement reports.",
        "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
        // For a remote Bot this message is the whole instruction, so the provenance rule has to
        // travel in it or the Bot never hears it. Referenced rather than restated, so the assertion
        // stays exact without pinning the wording twice.
        PROVENANCE_GUIDANCE,
      ].join("\n\n"),
    });
  });

  test("sends one standing role message ahead of the conversation", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const agents = await buildAgents(
      [remoteAgent(endpoint.url)],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      null,
    );

    const agent = agents.agent_expense;
    // A replayed thread already carries the standing message; it must not produce a second copy.
    agent?.setMessages([
      standingRoleMessage(profile),
      userMessage("Sort these."),
    ]);
    const result = await agent?.runAgent();

    const sent = endpoint.requests.at(-1);
    expect(sent?.messages).toEqual([
      standingRoleMessage(profile),
      userMessage("Sort these."),
    ]);
    expect(result?.newMessages?.at(-1)?.content).toBe("Categorized.");
  });

  test("keeps the standing role out of forwarded props and agent state", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const agents = await buildAgents(
      [remoteAgent(endpoint.url)],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      null,
    );

    const agent = agents.agent_expense;
    agent?.setMessages([userMessage("Sort these.")]);
    const result = await agent?.runAgent();

    /*
     * That a request was sent AT ALL is the first assertion, and it is the one that makes the rest
     * mean anything. `requests.at(-1)` on an empty log is `undefined`, and `JSON.stringify(undefined
     * ?? {})` is `"{}"`, which contains no "standing-role" and never will: every line below passed
     * with the agent key misspelled and no run performed.
     */
    expect(endpoint.requests).toHaveLength(1);
    expect(result?.newMessages?.at(-1)?.content).toBe("Categorized.");

    const [sent] = endpoint.requests;
    // And the standing role really did travel, so "not in forwardedProps, not in state" is an
    // assertion about WHERE it went rather than about whether it exists.
    expect(JSON.stringify(sent.messages)).toContain(
      "standing-role:agent_expense",
    );
    expect(JSON.stringify(sent.forwardedProps ?? {})).not.toContain(
      "standing-role",
    );
    expect(JSON.stringify(sent.state ?? {})).not.toContain("standing-role");
  });

  /*
   * Main's clone-preserving form of this test, kept, with the built-in probe this branch added.
   *
   * `fetch` alone does not cover the failure that branch was written against: if the
   * `type === "unavailable"` branch in `buildRegisteredAgent` stops catching this row, the tombstone
   * falls through to the BUILT-IN path, which answers from a model rather than by dialling an
   * endpoint. `BuiltInAgent.prototype.run` is the only place that shows up, so it is spied on
   * alongside the network.
   */
  test("preserves the deleted coworker refusal through runtime clones without network calls", async () => {
    const reason =
      "Expense Manager has been deleted and can no longer run. Its conversations remain readable.";
    let modelKeyRequests = 0;
    const network = spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("An unavailable agent must not make network calls");
    });
    const builtInRun = spyOn(BuiltInAgent.prototype, "run").mockImplementation(
      () => EMPTY,
    );
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const agents = await resolveRuntimeAgents(
        async () => [
          {
            id: "agent_expense",
            name: "Expense Manager",
            type: "unavailable",
            reason,
          },
        ],
        { provider: "openai", defaultModel: "gpt-5.6-terra" },
        async () => {
          modelKeyRequests += 1;
          return null;
        },
      );

      const original = agents.agent_expense;
      // The runtime calls agents[agentId].clone() before each run.
      const cloned = original.clone();
      const clonedAgain = cloned.clone();
      expect(cloned).not.toBe(original);
      expect(clonedAgain).not.toBe(cloned);
      for (const agent of [original, cloned, clonedAgain]) {
        expect(agent.agentId).toBe("agent_expense");
        expect(agent.description).toBe("Expense Manager");
        const events: string[] = [];
        await expect(
          agent.runAgent(
            { threadId: "deleted-bot-history", runId: "refused-run" },
            {
              onEvent: () => {
                events.push("event");
              },
              onRunError: () => {
                events.push("error");
              },
            },
          ),
        ).rejects.toMatchObject({ message: reason });
        expect(events).toEqual([]);
      }
      expect(modelKeyRequests).toBe(0);
      expect(network).not.toHaveBeenCalled();
      expect(builtInRun).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      builtInRun.mockRestore();
      network.mockRestore();
    }
  });

  test("resolves agents per request from the requesting actor", async () => {
    const seen: { request?: Request; actors: unknown[] } = { actors: [] };
    const factory = createRequestAgents(
      async (request) => {
        seen.request = request;
        return { id: "user-7", role: "user" as const };
      },
      async (actor) => {
        seen.actors.push(actor);
        return [remoteAgent("http://coworker.internal/ag-ui")];
      },
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      async () => null,
    );

    const request = new Request("http://openbot.test/api/copilotkit");
    const resolved = await factory({ request });

    expect(seen.request).toBe(request);
    expect(seen.actors).toEqual([{ id: "user-7", role: "user" }]);
    expectWrappedHttpTransport(resolved.agent_expense);
  });

  test("rebuilds each agent from the loader so an edited role applies to the next run", async () => {
    /*
     * READ OFF THE SECOND AGENT'S OWN RUN, not recomputed from the test's local.
     *
     * This closed with `expect(standingRoleMessage({ ...profile, roleDescription }).content)`,
     * which calls the same pure function the assertion is about with the same argument and asserts
     * it agrees with itself. It holds whatever `createRequestAgents` did with the roster, so the
     * one claim in the test's name — that the SECOND build carries the edited role — was never
     * made. A memoised roster behind a per-request rebuild passes it: two distinct agent objects,
     * both still saying "Review receipts."
     *
     * So the edited role is asserted where a person would meet it, on the wire out of the rebuilt
     * agent, which is also the only place a remote Bot ever hears its role at all.
     */
    await using endpoint = fakeAgUiEndpoint();
    let roleDescription = "Review receipts.";
    const factory = createRequestAgents(
      async () => ({ id: "user-7", role: "user" as const }),
      async () => [remoteAgent(endpoint.url, { roleDescription })],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      async () => null,
    );
    const request = new Request("http://openbot.test/api/copilotkit");

    const before = await factory({ request });
    roleDescription = "Reconcile corporate card statements.";
    const after = await factory({ request });

    expect(before.agent_expense).not.toBe(after.agent_expense);

    const rebuilt = after.agent_expense;
    if (!rebuilt)
      throw new Error("createRequestAgents returned no agent_expense");
    rebuilt.setMessages([userMessage("Sort these.")]);
    await rebuilt.runAgent();

    const sent = endpoint.requests.at(-1) as
      | { messages?: { content?: string }[] }
      | undefined;
    expect(sent?.messages?.[0]?.content).toBe(
      [
        "You are Expense Manager, Finance Operations.",
        "Reconcile corporate card statements.",
        "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
        PROVENANCE_GUIDANCE,
      ].join("\n\n"),
    );
  });

  function remoteAgent(
    endpoint: string,
    overrides: Partial<typeof profile> = {},
  ) {
    const resolved = { ...profile, ...overrides };
    return {
      id: resolved.id,
      name: resolved.name,
      type: "remote_ag_ui" as const,
      endpoint,
      standingMessage: standingRoleMessage(resolved),
    };
  }
});

function userMessage(content: string) {
  return { id: `user-${content}`, role: "user" as const, content };
}

describe("connected-vendor lookup diagnostics", () => {
  async function runWithVendors(loadVendors: () => Promise<readonly string[]>) {
    await using endpoint = fakeAgUiEndpoint();
    const agents = await buildAgents(
      [
        { ...assistantRow, type: "built_in", systemPrompt: "Be helpful." },
        {
          ...riskRow,
          endpoint: endpoint.url,
          standingMessage: standingRoleMessage(riskRow),
        },
      ],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      "synthetic-model-key",
      undefined,
      undefined,
      undefined,
      undefined,
      loadVendors,
    );
    expect(agents["general-assistant"]).toBeInstanceOf(BuiltInAgent);
    const remote = agents.risk;
    if (!remote) throw new Error("Fixture remote agent was not built.");
    await remote.clone().runAgent();
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0]).toMatchObject({ tools: [] });
    return JSON.stringify(endpoint.requests[0]);
  }

  test("reports a failed lookup once for the roster and still completes the run", async () => {
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runWithVendors(async () => {
        throw new Error(
          "postgres://fixture:secret@localhost/fixture private prompt",
        );
      });
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledWith({
        error: "connected_vendor_lookup_failed",
        context: { operation: "loadVendors", agentCount: 2 },
        timestamp: expect.any(String),
      });
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret");
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(
        "private prompt",
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  test.each([[], ["google-drive"]])(
    "a successful vendor lookup stays quiet: %j",
    async (...vendors: string[]) => {
      const diagnostic = spyOn(console, "error").mockImplementation(() => {});
      try {
        const sent = await runWithVendors(async () => vendors);
        expect(sent.includes("This deployment also connects to:")).toBe(
          vendors.length > 0,
        );
        if (vendors.length > 0) expect(sent).toContain("google-drive");
        expect(diagnostic).not.toHaveBeenCalled();
      } finally {
        diagnostic.mockRestore();
      }
    },
  );
});

/**
 * An AG-UI server that records what it was sent and answers with a complete run, so the standing
 * role can be asserted on the wire rather than on the object that was supposed to send it.
 */
function fakeAgUiEndpoint() {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const input = (await request.json()) as Record<string, unknown>;
      requests.push(input);
      const { threadId, runId } = input as { threadId: string; runId: string };
      const events = [
        { type: "RUN_STARTED", threadId, runId },
        { type: "TEXT_MESSAGE_START", messageId: "reply-1", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "reply-1",
          delta: "Categorized.",
        },
        { type: "TEXT_MESSAGE_END", messageId: "reply-1" },
        { type: "RUN_FINISHED", threadId, runId },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });

  return {
    requests,
    url: `http://localhost:${server.port}/ag-ui`,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}

/**
 * A Bot is told what it holds, not only handed it.
 *
 * A tool array tells a model a tool exists. It does not say the tool is the right way to reach that
 * system, and it competes with `COMPUTER_GUIDANCE`: a page of emphatic prose about the browser that
 * every Bot gets whether or not it has a single connector, and that mentions connectors nowhere.
 *
 * The browser prose won. A Bot holding four Google Drive tools browsed to drive.google.com, met a
 * sign-in page its container could never satisfy, and asked its person to sign in to a vendor that
 * person had already connected. Asked a question with no tool for it, another went reading a
 * government website and looped on its 404 page.
 *
 * Both kinds are asserted because they are built by different functions, and the remote one is the
 * one that failed in the product.
 */
describe("what a Bot is told it holds", () => {
  const drive = [
    { name: "mcp__google-drive__search_files" },
    { name: "mcp__google-drive__read_file_content" },
  ] as never[];

  test("names the system and its tools", () => {
    const guidance = grantedToolGuidance(drive);
    expect(guidance).toContain("google-drive");
    expect(guidance).toContain("search_files");
    expect(guidance).toContain("read_file_content");
  });

  test("says not to browse to a vendor it has a tool for", () => {
    // The whole point. Without this line the tool list is inert beside the browser prose.
    expect(grantedToolGuidance(drive).toLowerCase()).toContain("do not browse");
  });

  test("says a gap in what it holds is a grant to ask for, not a wall to climb", () => {
    /*
     * The half of the Drive failure the "do not browse" line does not cover.
     *
     * Only `search_files` was granted. The Bot found the document, had no way to read it, and
     * surfaced that as an authentication problem on `docs.google.com`: it opened the vendor, met
     * Google's sign-in page and asked its person to take the wheel and sign in. They already had
     * access. The Bot lacked a grant, and nothing on screen said so.
     *
     * A sentence naming the missing capability points at the screen that fixes it. A sign-in box
     * does not, and asking the person to fetch it instead is the same mistake wearing a hat.
     */
    // Whitespace-normalised: the guidance is assembled line by line, so a sentence spans a newline
    // wherever the source happened to wrap, which is not a fact about what the Bot is told.
    const guidance = grantedToolGuidance(drive)
      .toLowerCase()
      .replace(/\s+/g, " ");
    expect(guidance).toContain("missing grant");
    expect(guidance).toContain("name the capability");
    expect(guidance).toContain("administrator can grant it");
    expect(guidance).toContain("do not ask the person to sign in");
  });

  test("names a connected vendor it holds nothing for, so it can say which", () => {
    /*
     * The case a Bot holding no grants used to be told nothing about.
     *
     * The deployment had Google Drive connected and this Bot was not on it, so the guidance was
     * empty and the Bot treated the vendor as an ordinary website: it opened Google's sign-in page
     * and asked a person to sign in to an account the deployment had already connected. The
     * connector existed; nothing said the Bot simply was not on it.
     */
    const guidance = grantedToolGuidance([], ["google-drive"])
      .toLowerCase()
      .replace(/\s+/g, " ");

    expect(guidance).toContain("google-drive");
    expect(guidance).toContain("you hold none of their tools");
    expect(guidance).toContain("have not been granted it");
    expect(guidance).toContain("do not browse to its website");
  });

  test("does not name a vendor it does hold as one it does not", () => {
    // The list is the deployment's, so it includes what this Bot has. Saying "you hold none of
    // their tools" about a system it is holding four tools for would be worse than saying nothing.
    const guidance = grantedToolGuidance(drive, ["google-drive"]);

    expect(guidance).toContain("search_files");
    expect(guidance.toLowerCase()).not.toContain(
      "you hold none of their tools",
    );
  });

  test("says nothing at all when the Bot holds nothing", () => {
    // A deployment with no connectors must not be told about connectors it does not have.
    expect(grantedToolGuidance([])).toBe("");
    expect(grantedToolGuidance([], [])).toBe("");
  });

  test("a built-in Bot is told before it is told about the browser", () => {
    const prompt = builtInAgentConfiguration(
      {
        id: "risk-analyst",
        name: "Risk Analyst",
        type: "built_in",
        systemPrompt: "Investigate policies.",
      },
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      "openai-secret",
      drive,
      "BROWSER GUIDANCE HERE",
    ).prompt as string;

    // Order is the fix, not merely presence: the grants have to land before the browser prose.
    expect(prompt.indexOf("google-drive")).toBeGreaterThan(-1);
    expect(prompt.indexOf("google-drive")).toBeLessThan(
      prompt.indexOf("BROWSER GUIDANCE HERE"),
    );
  });
});

/**
 * Where an answer came from, on every Bot rather than the ones somebody remembered.
 *
 * Asked what the obligation was for twelve cash deposits under the reporting threshold, the
 * compliance Bot answered with a filing requirement, a dollar threshold, a thirty-day deadline and a
 * five-year retention period. The audit trail for that turn holds exactly one row: the routing
 * decision. No tool call, no source, and nothing saying the answer came from the model.
 *
 * One package's `knowledge` Bot had a rule against this in its YAML. The Bot whose entire subject is
 * regulatory obligation did not, because a `remote-ag-ui` agent gets its role description and
 * nothing else. That asymmetry is the bug: a rule this important living in one agent's YAML is a
 * rule the next agent will not have.
 *
 * So both paths are asserted, because they are built by different functions and a fix to one is not
 * a fix to the other.
 */
describe("where a Bot says its answer came from", () => {
  test("a built-in Bot carries the rule even holding nothing at all", () => {
    // The Bot that needs it most. No tools and no computer means nothing it says was read anywhere.
    const prompt = builtInAgentConfiguration(
      {
        id: "general-assistant",
        name: "General Assistant",
        type: "built_in",
        systemPrompt: "Be helpful.",
      },
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      "openai-secret",
    ).prompt as string;

    expect(prompt).toContain(PROVENANCE_GUIDANCE);
  });

  test("a remote Bot carries it in the only instruction it ever gets", () => {
    const content = standingRoleMessage({
      id: "risk-analyst",
      name: "Risk Analyst",
      title: "Risk & Compliance",
      roleDescription:
        "Investigate policies, transaction monitoring, and control evidence.",
    }).content;

    expect(content).toContain(PROVENANCE_GUIDANCE);
  });

  test("it does not send the Bot hunting for a source", () => {
    /*
     * The failure mode of the first attempt at this, which never left a branch. Told to find a
     * source, Bots went reading the open web and looped on a government 404 page. An unsourced
     * answer that says it is unsourced is honest; a search that never ends is a Bot that never
     * answers.
     */
    const guidance = PROVENANCE_GUIDANCE.toLowerCase().replace(/\s+/g, " ");
    expect(guidance).toContain("this is not an instruction to go looking");
    expect(guidance).toContain("mark it plainly as unverified");
    expect(guidance).toContain("do not go hunting the open web");
  });

  test("it names the answers that must not be stated without a source", () => {
    // The general rule is easy to read past. The list is what makes it bite on the turn that
    // produced this: a threshold, a deadline, a filing obligation, a figure.
    const guidance = PROVENANCE_GUIDANCE.toLowerCase().replace(/\s+/g, " ");
    for (const kind of [
      "threshold",
      "deadline",
      "filing obligation",
      "figure",
    ]) {
      expect(guidance).toContain(kind);
    }
  });
});

/**
 * The person's own standing instructions, and where they land in a prompt.
 *
 * The third instruction carrier. A role is the coworker's and reads the same to everybody; a skill
 * is pulled in for one task. This is the person's, and it is true of every task they ask for, which
 * is why the only interesting properties are about placement and precedence rather than about
 * content: WHERE it sits relative to the role, that it is absent when nobody has written any, that
 * it never reaches a Bot at somebody else's endpoint, and that failing to read it costs a paragraph
 * rather than a run.
 */
describe("a person's standing instructions", () => {
  const assistant = {
    id: "general-assistant",
    name: "General Assistant",
    type: "built_in" as const,
    systemPrompt: "Be helpful.",
  };
  const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };

  const promptWith = (instructions: string | null) =>
    builtInAgentConfiguration(
      assistant,
      model,
      "openai-secret",
      [],
      undefined,
      [],
      instructions,
    ).prompt as string;

  test("carries the block, its precedence sentence, and the person's own words", () => {
    const prompt = promptWith("Write in British English.");

    expect(prompt).toContain(
      "The person you are working with has standing instructions that apply in every channel and every task, alongside your role: Write in British English.",
    );
    /*
     * The precedence sentence is part of the block rather than decoration. Two standing instructions
     * in one prompt is a conflict resolved by whichever the model read last, and the resolution is
     * not symmetric: "always answer in one line" must not quietly override a role that exists to
     * produce a filing with its sources in it.
     */
    expect(prompt).toContain(
      "Where the two conflict, the role decides what you do and these decide how you do it.",
    );
  });

  test("sits after the role and before everything the deployment adds", () => {
    const prompt = builtInAgentConfiguration(
      assistant,
      model,
      "openai-secret",
      [{ name: "mcp__google-drive__search_files" }] as never[],
      "Computer guidance.",
      [],
      "Write in British English.",
    ).prompt as string;

    // The role, then who it is working for, then what it holds, then its hands. Asserted as
    // positions rather than as presence, because the order is the part that was decided.
    expect(prompt.indexOf("Be helpful.")).toBeLessThan(
      prompt.indexOf("standing instructions that apply in every channel"),
    );
    expect(
      prompt.indexOf("standing instructions that apply in every channel"),
    ).toBeLessThan(prompt.indexOf("google-drive"));
    expect(prompt.indexOf("google-drive")).toBeLessThan(
      prompt.indexOf("Computer guidance."),
    );
  });

  test.each([[null], [undefined], [""], ["   \n  "]])(
    "adds nothing at all when there are none: %j",
    (instructions) => {
      const prompt = promptWith(instructions as string | null);

      expect(prompt).not.toContain("standing instructions");
      // Byte for byte what a deployment had before any of this existed, which is what most people
      // on most days get.
      expect(prompt).toBe(`Be helpful.\n\n${PROVENANCE_GUIDANCE}`);
    },
  );

  test("is read once for a whole roster, and only when somebody built-in will be told it", async () => {
    let reads = 0;
    const loadInstructions = async () => {
      reads += 1;
      return "Write in British English.";
    };

    await buildAgents(
      [
        assistant,
        { ...assistant, id: "second-assistant", name: "Second Assistant" },
      ],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      loadInstructions,
    );
    // One person, one row: asking per Bot would be the same read once for each of them.
    expect(reads).toBe(1);

    await buildAgents(
      [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      loadInstructions,
    );
    /*
     * Not read at all for a roster with nothing built-in. A remote Bot composes its own prompt at
     * somebody else's endpoint, so this deployment has nowhere to put the text and no reason to pay
     * for reading it.
     */
    expect(reads).toBe(1);
  });

  test("never reaches a Bot at somebody else's endpoint", () => {
    const content = standingRoleMessage({
      id: "risk",
      name: "Risk",
      title: "Risk & Compliance",
      roleDescription: "Investigate policies and controls.",
    }).content;

    expect(content).not.toContain("standing instructions that apply");
  });

  async function runWithInstructions(loadInstructions: LoadInstructions) {
    const recorder = new LLMock();
    await using endpoint = fakeAgUiEndpoint();
    const originalBase = process.env.OPENAI_BASE_URL;
    try {
      process.env.OPENAI_BASE_URL = await recorder.start();
      recorder.onMessage(/.*/, { type: "text", content: "Fixture completed." });
      const agents = await buildAgents(
        [
          assistant,
          { ...assistant, id: "second-assistant", name: "Second Assistant" },
          {
            ...riskRow,
            endpoint: endpoint.url,
            standingMessage: standingRoleMessage(riskRow),
          },
        ],
        model,
        "synthetic-model-key",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        loadInstructions,
      );
      const builtIn = agents[assistant.id]?.clone();
      const remote = agents.risk?.clone();
      if (!builtIn || !remote) throw new Error("Expected the fixture roster.");
      builtIn.addMessage({
        id: "fixture-request",
        role: "user",
        content: "Complete the fixture request.",
      });
      await builtIn.runAgent();
      await remote.runAgent();
      expect(builtIn.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: "Fixture completed.",
      });
      expect(recorder.getRequests()).toHaveLength(1);
      expect(endpoint.requests).toHaveLength(1);
      return {
        modelRequest: JSON.stringify(recorder.getRequests()[0]?.body),
        remoteRequest: JSON.stringify(endpoint.requests[0]),
      };
    } finally {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      await recorder.stop();
    }
  }

  test("reports a failed instruction read once and still completes a built-in run", async () => {
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    let reads = 0;
    try {
      const sent = await runWithInstructions(async () => {
        reads += 1;
        throw new Error(
          "postgres://fixture:synthetic-secret@localhost/fixture private instruction",
        );
      });
      expect(reads).toBe(1);
      expect(sent.modelRequest).not.toContain("standing instructions");
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledWith({
        error: "standing_instruction_read_failed",
        context: { operation: "loadInstructions", agentCount: 3 },
        timestamp: expect.any(String),
      });
      const logs = JSON.stringify(diagnostic.mock.calls);
      for (const sensitive of [
        "postgres://",
        "synthetic-secret",
        "private instruction",
        "synthetic-model-key",
      ]) {
        expect(logs).not.toContain(sensitive);
        expect(sent.remoteRequest).not.toContain(sensitive);
      }
    } finally {
      diagnostic.mockRestore();
    }
  });

  test.each([null, "Write in British English."])(
    "a successful instruction read stays quiet and private: %j",
    async (instructions) => {
      const diagnostic = spyOn(console, "error").mockImplementation(() => {});
      let reads = 0;
      try {
        const sent = await runWithInstructions(async () => {
          reads += 1;
          return instructions;
        });
        expect(reads).toBe(1);
        expect(sent.modelRequest.includes("standing instructions")).toBe(
          instructions !== null,
        );
        if (instructions) expect(sent.modelRequest).toContain(instructions);
        expect(sent.remoteRequest).not.toContain("standing instructions");
        expect(sent.remoteRequest).not.toContain("Write in British English.");
        expect(diagnostic).not.toHaveBeenCalled();
      } finally {
        diagnostic.mockRestore();
      }
    },
  );

  test("a remote-only roster never reads or diagnoses personal instructions", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    let reads = 0;
    try {
      const agents = await buildAgents(
        [
          {
            ...riskRow,
            endpoint: endpoint.url,
            standingMessage: standingRoleMessage(riskRow),
          },
        ],
        model,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => {
          reads += 1;
          throw new Error("Private instructions must never be read here.");
        },
      );
      const remote = agents.risk;
      if (!remote) throw new Error("Expected the fixture remote agent.");
      await remote.runAgent();
      expect(endpoint.requests).toHaveLength(1);
      expect(reads).toBe(0);
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      diagnostic.mockRestore();
    }
  });

  test("is resolved for whoever the request turned out to be", async () => {
    const asked: string[] = [];
    const factory = createRequestAgents(
      async () => ({ id: "user-7", role: "user" as const }),
      async () => [assistant],
      model,
      async () => "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (actorId) => async () => {
        asked.push(actorId);
        return "Write in British English.";
      },
    );

    await factory({
      request: new Request("http://openbot.test/api/copilotkit"),
    });

    /*
     * The actor from `identifyActor`, never anything in the request body. This text goes into a
     * prompt that then speaks as that person's coworker in every channel they work in, so which
     * person it belongs to is the session's answer and nobody else's.
     */
    expect(asked).toEqual(["user-7"]);
  });
});

/**
 * The dangling tool call, refused before it reaches the model provider.
 *
 * FOUND LIVE. Three consecutive attempts to say anything in one conversation failed with
 * `AI_MissingToolResultsError: Tool result is missing for tool call chatcmpl-tool-8dd56dc7497c5ea9`.
 * A frontend tool handler had been torn down while its call was open, so the browser's live agent
 * messages carried an assistant message whose tool call would never be answered, and each retry sent
 * it back up as `input.messages`. `BuiltInAgent.run` converts those messages itself, so the only
 * place a guard can stand is in front of it, and these are the properties that say it is standing
 * there: on the agent a request is handed, on the clone the runtime makes before every run, and on
 * the narrowed path, which builds its agent again per run.
 */
describe("a chat turn is not sent a conversation the model API refuses", () => {
  const assistant = {
    id: "general-assistant",
    name: "General Assistant",
    type: "built_in" as const,
    systemPrompt: "Be helpful.",
  };
  const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };

  /** The messages a run reaches `BuiltInAgent.run` with, without a model call behind them. */
  function captureRuns() {
    const seen: RunAgentInput[] = [];
    const spy = spyOn(BuiltInAgent.prototype, "run").mockImplementation(
      (input: RunAgentInput) => {
        seen.push(input);
        return EMPTY;
      },
    );
    return { seen, restore: () => spy.mockRestore() };
  }

  function input(
    messages: unknown[],
    resume?: { interruptId: string; status: "resolved" }[],
  ): RunAgentInput {
    return {
      threadId: "thread_1",
      runId: "run_1",
      messages: messages as RunAgentInput["messages"],
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
      ...(resume === undefined ? {} : { resume }),
    };
  }

  const danglingCall = [
    { id: "m1", role: "user", content: "Save that." },
    {
      id: "m2",
      role: "assistant",
      content: "Saving it.",
      toolCalls: [
        {
          id: "chatcmpl-tool-8dd56dc7497c5ea9",
          type: "function",
          function: { name: "saveDocument", arguments: "{}" },
        },
      ],
    },
    { id: "m3", role: "user", content: "Did that work?" },
  ];

  /**
   * The Bot under test, or a failure that says it was never built.
   *
   * Returned non-optional on purpose: `agent?.run(...)` on an undefined agent runs nothing, and what
   * the callers below then assert against is an empty `seen`, which reads as "the guard dropped
   * everything" rather than as "there was no agent". The subscribing caller has it worse and hangs
   * to the suite's timeout.
   */
  async function builtIn() {
    const agents = await buildAgents([assistant], model, "openai-secret");
    const agent = agents["general-assistant"];
    if (!agent) throw new Error('buildAgents returned no "general-assistant"');
    return agent;
  }

  test("the unanswerable call is gone from what the run converts", async () => {
    const agent = await builtIn();
    const { seen, restore } = captureRuns();

    try {
      agent.run(input(danglingCall));
    } finally {
      restore();
    }

    const messages = seen[0]?.messages ?? [];
    // Everything the person and the Bot said survives. Only the call nothing will ever answer is
    // gone, and with it the message that carried nothing else.
    expect(messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    expect(messages[1]).not.toHaveProperty("toolCalls");
    // And the caller's own array is untouched, because the browser goes on using it.
    expect(danglingCall[1]).toHaveProperty("toolCalls");
  });

  test("the clone the runtime runs guards it too", async () => {
    // `agents[agentId].clone()` happens before every single run, and the base class's clone builds a
    // plain `BuiltInAgent`. Inherited unchanged, the guard would never once be reached in production.
    const agent = (await builtIn()).clone();
    const { seen, restore } = captureRuns();

    try {
      agent.run(input(danglingCall));
    } finally {
      restore();
    }

    expect(seen[0]?.messages).toHaveLength(3);
    expect(seen[0]?.messages?.[1]).not.toHaveProperty("toolCalls");
  });

  test("a call the run is about to resume is kept", async () => {
    /*
     * `run` appends a tool result per `input.resume` entry, keyed by `interruptId`, AFTER converting
     * the messages. So an interrupted call is the one dangle that is not a dangle: dropping it would
     * leave that appended result pointing at a call no longer in the conversation, which is the same
     * error arriving from the other side.
     */
    const agent = await builtIn();
    const { seen, restore } = captureRuns();

    try {
      agent.run(
        input(danglingCall, [
          { interruptId: "chatcmpl-tool-8dd56dc7497c5ea9", status: "resolved" },
        ]),
      );
    } finally {
      restore();
    }

    expect(seen[0]?.messages?.[1]).toMatchObject({
      toolCalls: [{ id: "chatcmpl-tool-8dd56dc7497c5ea9" }],
    });
  });

  test("a remote Bot is not sent the unanswerable call either", async () => {
    /*
     * A remote Bot never passes through `BuiltInAgentWithSaneHistory`: its middleware forwards the
     * browser's messages to the endpoint as they are. A framework there that converts with the
     * same SDK refuses the same conversation, so the guard is applied in that middleware, and
     * asserted on the wire.
     */
    await using endpoint = fakeAgUiEndpoint();
    const agents = await buildAgents(
      [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui" as const,
          endpoint: endpoint.url,
          standingMessage: standingRoleMessage(riskRow),
        },
      ],
      model,
      null,
    );

    // `built`, not `agents.risk` with an optional chain. On an undefined agent the chained form
    // makes `setMessages` and `runAgent` no-ops, and the test then fails — if it fails at all — on
    // `expect(endpoint.requests).toHaveLength(1)`, which says nothing was sent rather than that
    // there was nothing to send it with.
    const agent = built(agents, "risk");
    agent.setMessages(danglingCall as never[]);
    await agent.runAgent();

    // Not vacuous without this — `sent` would be undefined and `sent.map` would throw — but it
    // throws saying "undefined is not an object" rather than "nothing was ever sent".
    expect(endpoint.requests).toHaveLength(1);
    const sent = endpoint.requests.at(-1)?.messages as {
      id: string;
      toolCalls?: unknown[];
    }[];
    expect(sent.map((message) => message.id)).toEqual([
      "standing-role:risk",
      "m1",
      "m2",
      "m3",
    ]);
    expect(sent[2]).not.toHaveProperty("toolCalls");
  });

  test("the narrowed path is guarded, because it builds its agent the same way", async () => {
    // Tool selection defers the build to the run, so this is a different agent object than the one
    // the request was handed. It is built through the same `withTools`, and that is the property.
    const granted = Array.from({ length: 3 }, (_, index) => ({
      ref: `drive/tool_${index}`,
      name: `mcp__drive__tool_${index}`,
      description: `drive tool ${index}`,
    })) as never[];
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      {
        loadSkills: async () => [
          {
            slug: "drive-audit",
            title: "Drive audit",
            summary: "Read documents out of Google Drive.",
            tools: ["drive/tool_0"],
          },
        ],
        choose: async () => JSON.stringify({ skills: ["drive-audit"] }),
        floor: 0,
      },
    );
    const agent = agents["general-assistant"];
    if (!agent) throw new Error('buildAgents returned no "general-assistant"');
    const { seen, restore } = captureRuns();

    // Kept rather than discarded: `error: () => resolve()` here turned a run that failed outright
    // into a passing test, and the same handler is what swallows anything thrown inside the
    // narrowing callbacks this build is wired with.
    const failed: Error[] = [];
    try {
      // Subscribed, because the narrowing wrapper builds the inner agent lazily on subscription.
      await new Promise<void>((resolve) => {
        agent.run(input(danglingCall)).subscribe({
          complete: resolve,
          error: (error: Error) => {
            failed.push(error);
            resolve();
          },
        });
      });
    } finally {
      restore();
    }

    expect(failed).toEqual([]);
    expect(seen[0]?.messages).toHaveLength(3);
    expect(seen[0]?.messages?.[1]).not.toHaveProperty("toolCalls");
  });
});

/**
 * The two places `resolveAttachmentParts` is called, and the one place it deliberately is not.
 *
 * `server/tests/attachment-parts.test.ts` covers the pure resolver, and covers it well, but nothing
 * anywhere pins that the resolver is actually reached from a run. Delete either call below and that
 * whole suite stays green, because it never builds an agent. A loader that returns null makes
 * `resolveAttachmentParts` throw, naming the id; nothing here catches, so the throw is the proof the
 * call happened at all.
 *
 * `RunBuiltAgent.run` (built when narrowing or handoff is active) is asserted by exclusion: the loader
 * must be called exactly once for a one-attachment message, because `RunBuiltAgent.run` delegates to
 * an inner `BuiltInAgentWithSaneHistory` whose own `run` is the one that inlines the attachment. A
 * second call anywhere in that path would make it two. That loader has to RESOLVE for the count to
 * mean anything; see the test itself.
 *
 * And the last two tests are the other half of the throw: it belongs to the message being asked
 * about, which is the last user message, and NOT to the history behind it, where a vanished row
 * would otherwise kill the channel permanently.
 */
describe("where an attachment reaches the model, and where it deliberately does not", () => {
  const assistant = {
    id: "general-assistant",
    name: "General Assistant",
    type: "built_in" as const,
    systemPrompt: "Be helpful.",
  };
  const model = { provider: "openai" as const, defaultModel: "gpt-5.6-terra" };

  function input(messages: unknown[]): RunAgentInput {
    return {
      threadId: "thread_1",
      runId: "run_1",
      messages: messages as RunAgentInput["messages"],
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
    };
  }

  /**
   * Runs to its first error, with the model held off.
   *
   * THE SPY IS NOT A CONVENIENCE. Every caller here is asserting that a run REFUSES over an
   * attachment it could not load, and the way that assertion regresses is the refusal disappearing —
   * at which point the run carries on into `BuiltInAgent.run` and a real model call against
   * whatever key the environment happens to hold. `EMPTY` completes at once instead, and completion
   * is what this returns as the failure, so the regression is a fast red test rather than a live
   * request.
   */
  async function runToError(
    agent: AbstractAgent,
    runInput: RunAgentInput,
  ): Promise<Error> {
    const spy = spyOn(BuiltInAgent.prototype, "run").mockImplementation(
      () => EMPTY,
    );
    try {
      return await new Promise<Error>((resolve) => {
        agent.run(runInput).subscribe({
          error: resolve,
          complete: () => resolve(new Error("expected the run to error")),
        });
      });
    } finally {
      spy.mockRestore();
    }
  }

  /**
   * Runs to completion with the model held off, handing back whatever the run failed with.
   *
   * RETURNED RATHER THAN SWALLOWED. `error: () => resolve()` is what these subscribes used to say,
   * which quietly turns a failed run — and any assertion thrown inside a loader the run calls — into
   * a passing test. A caller that expects the run to succeed asserts on an empty array and finds out
   * either way.
   *
   * `onRun` is handed the input `BuiltInAgent.run` was called with, which is where a caller checks
   * what the model would have been sent.
   */
  async function runToCompletion(
    agent: AbstractAgent,
    runInput: RunAgentInput,
    onRun: (received: RunAgentInput) => void = () => {},
  ): Promise<Error[]> {
    const spy = spyOn(BuiltInAgent.prototype, "run").mockImplementation(
      (received: RunAgentInput) => {
        onRun(received);
        return EMPTY;
      },
    );
    const failed: Error[] = [];
    try {
      await new Promise<void>((resolve) => {
        agent.run(runInput).subscribe({
          complete: resolve,
          error: (error: Error) => {
            failed.push(error);
            resolve();
          },
        });
      });
    } finally {
      spy.mockRestore();
    }
    return failed;
  }

  /** One user message, one attachment, pointing at a file this deployment cannot load. */
  const attachmentMessage = [
    {
      id: "m1",
      role: "user" as const,
      content: [
        {
          type: "image",
          source: { type: "url", value: "/api/attachments/abc" },
          metadata: { attachmentId: "abc" },
        },
      ],
    },
  ];

  test("a built-in Bot's run fails naming the attachment it could not load", async () => {
    // Protects `BuiltInAgentWithSaneHistory.run` (copilot.ts:~924). Drop the
    // `inlineAttachments` call there and this run completes instead of erroring.
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => null,
    );
    const error = await runToError(
      built(agents, "general-assistant"),
      input(attachmentMessage),
    );

    expect(error.message).toContain('"abc"');
  });

  test("a remote Bot's run fails naming the attachment it could not load", async () => {
    // Protects the remote `.use()` middleware's `runWith` (copilot.ts:~777).
    // Drop the `inlineAttachments` call there and this rejection never fires.
    const agents = await buildAgents(
      [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui" as const,
          endpoint: "http://risk.internal/ag-ui",
          standingMessage: standingRoleMessage(riskRow),
        },
      ],
      model,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => null,
    );
    // Through `built`, not `agents.risk?.`, for the reason `built` was written: on an optional
    // chain a `buildAgents` that stopped returning this Bot makes `setMessages` a silent no-op and
    // `expect(undefined).rejects` a type complaint, neither of which names the actual failure.
    const agent = built(agents, "risk");
    agent.setMessages(attachmentMessage as never[]);

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(agent.runAgent()).rejects.toThrow(
        'Attachment "abc" could not be loaded',
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("the narrowed built-in path reads the attachment once, not twice", async () => {
    /*
     * Protects the exclusion: `RunBuiltAgent.run` (copilot.ts:~989) deliberately does not call
     * `resolveAttachmentParts` itself. It only delegates to the built-in agent its `build()`
     * produces, and that agent's own `run` is what inlines the attachment. Re-adding the call at
     * `RunBuiltAgent.run` would read the same attachment a second time, which is what turns this
     * count from one into two.
     */
    /*
     * A loader that RESOLVES, which is what makes the count mean anything. With one that returned
     * null the first resolution threw, the second never ran, and the count was one whether or not
     * `RunBuiltAgent.run` inlined as well — this test passed with the very double call it exists to
     * forbid. Verified by adding that call back: with a real row here it fails at 2.
     *
     * WHAT IT WAS ASKED FOR IS RECORDED, NOT ASSERTED HERE. This loader runs inside the subscribe
     * below, whose `error` handler resolves the promise rather than rethrowing, and bun does not
     * fail a test on an `expect` whose throw was caught by something: `expect(id).toBe("WRONG-ID")`
     * in this position was green. The recorded ids are asserted after the run, where a failure is
     * the test's own.
     */
    const loaded: string[] = [];
    const loadAttachment = async (id: string) => {
      loaded.push(id);
      return {
        mimeType: "image/png",
        name: "abc.png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      };
    };
    const granted = Array.from({ length: 3 }, (_, index) => ({
      ref: `drive/tool_${index}`,
      name: `mcp__drive__tool_${index}`,
      description: `drive tool ${index}`,
    })) as never[];

    // Narrowing active, same fixtures as "the narrowed path is guarded" above, so this Bot is
    // built as a `RunBuiltAgent` rather than a plain `BuiltInAgentWithSaneHistory`.
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      {
        loadSkills: async () => [
          {
            slug: "drive-audit",
            title: "Drive audit",
            summary: "Read documents out of Google Drive.",
            tools: ["drive/tool_0"],
          },
        ],
        choose: async () => JSON.stringify({ skills: ["drive-audit"] }),
        floor: 0,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      loadAttachment,
    );
    const failed = await runToCompletion(
      built(agents, "general-assistant"),
      input(attachmentMessage),
    );

    expect(failed).toEqual([]);
    // One read, of the attachment this message actually names. Two is the double call this test
    // forbids; a different id is a read of something nobody asked for.
    expect(loaded).toEqual(["abc"]);
  });

  /** A user message carrying one attachment, named so a note about it can be recognised. */
  function attached(id: string, filename: string, messageId: string) {
    return {
      id: messageId,
      role: "user" as const,
      content: [
        {
          type: "image",
          source: { type: "url", value: `/api/attachments/${id}` },
          metadata: { attachmentId: id, filename },
        },
      ],
    };
  }

  /** Somebody attached a file a while ago, said something else since, and is asking again now. */
  const twoTurns = [
    attached("old", "budget.png", "m1"),
    { id: "m2", role: "assistant" as const, content: "Looks fine." },
    attached("abc", "photo.png", "m3"),
  ];

  const stored = {
    mimeType: "image/png",
    name: "photo.png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  };

  async function builtInWith(loadAttachment: LoadAttachment) {
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      loadAttachment,
    );
    return built(agents, "general-assistant");
  }

  test("an attachment that vanished from an older message becomes a note", async () => {
    /*
     * The permanence half of the same argument. `inlineAttachments` maps over the WHOLE history and
     * history is replayed every turn, so a row deleted by the sweeper after an interrupted send
     * would otherwise fail this channel's every future turn for ever, exactly as the dangling call
     * in `agents/history-sanitize.ts` did in production. The old part says the file is gone; the
     * one the person is actually asking about still arrives as bytes.
     */
    const agent = await builtInWith(async (id) =>
      id === "abc" ? stored : null,
    );

    const seen: RunAgentInput[] = [];
    const failed = await runToCompletion(agent, input(twoTurns), (received) => {
      seen.push(received);
    });

    // The thread still runs. That is the whole point: one dead file, not a dead channel.
    expect(failed).toEqual([]);
    const messages = seen[0]?.messages ?? [];
    expect(messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    expect((messages[0] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: '[attachment "budget.png" is no longer available]',
      },
    ]);
    expect(
      (messages[2] as { content?: { source?: unknown }[] }).content?.[0]
        ?.source,
    ).toMatchObject({ type: "data" });
  });

  test("the message being asked about still fails, history behind it or not", async () => {
    // The strictness that matters is unchanged: the file THIS turn names is unloadable, and no Bot
    // is going to answer about it. Only the messages behind it are allowed to degrade.
    const agent = await builtInWith(async (id) =>
      id === "old" ? { ...stored, name: "budget.png" } : null,
    );

    const error = await runToError(agent, input(twoTurns));

    expect(error.message).toContain('"abc"');
  });

  /*
   * Which message is a SEND, and therefore which attachments `attachedAt` may be written for.
   *
   * Only the last user message is: everything behind it is history, replayed in full on every turn
   * and by whoever happens to be running that turn. A stamp written where the file is READ cannot
   * tell those apart, so it says "sent" about every file anybody has ever been shown — which is the
   * one thing `attachedAt` must never mean, because the sweeper, the upload cap and the withdrawal
   * route all read it as "this rode in a message somebody sent".
   *
   * Delete the mark from `inlineAttachments` and `marked` stays empty; move it out of the
   * `index === asked` branch and `old` joins it. Both are the failure this pins.
   */
  test("the message being asked about is marked as sent, and the history behind it is not", async () => {
    const marked: string[][] = [];
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // Everything resolves, so nothing throws and every message in `twoTurns` is inlined — which
      // is exactly the condition under which a read-time stamp would have marked both of them.
      async () => stored,
      async (ids: readonly string[]) => {
        marked.push([...ids]);
      },
    );
    const failed = await runToCompletion(
      built(agents, "general-assistant"),
      input(twoTurns),
    );

    expect(failed).toEqual([]);
    expect(marked).toEqual([["abc"]]);
  });

  /*
   * AND IT IS STAMPED ONLY IF THE WHOLE WALK CAME BACK, which is a question about WHEN rather than
   * about which message.
   *
   * `inlineAttachments` walks backwards, so the message being asked about is the FIRST thing it
   * resolves and every older message is still ahead of it. The stamp was written the moment that
   * message resolved, so a history load that rejected afterwards failed the turn with `attachedAt`
   * already recorded for it — a stamp for a turn that never ran. `"note"` does not cover this: it
   * softens a row that is MISSING, not a read that fails, so a pool error or a timeout on any older
   * message still propagates and still fails the run.
   *
   * That is not a cosmetic inaccuracy. The stamp's entire meaning is "this file reached a message
   * somebody actually sent", and three readers act on it — the sweeper's delete, the upload cap, the
   * withdrawal route. Moving the write past the end of the loop is what this pins: with it inside,
   * `marked` holds `["abc"]` here, and the file is treated for ever as having been sent by a turn
   * that errored.
   */
  test("a history load that fails leaves nothing stamped as sent", async () => {
    const marked: string[][] = [];
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // The message being asked about resolves cleanly — that is the point. It is the OLDER one,
      // reached after the stamp used to be written, whose read falls over.
      async (id: string) => {
        if (id === "old") {
          throw new Error("connection terminated unexpectedly");
        }
        return stored;
      },
      async (ids: readonly string[]) => {
        marked.push([...ids]);
      },
    );

    const failed = await runToCompletion(
      built(agents, "general-assistant"),
      input(twoTurns),
    );

    // The turn really did fail, so the assertion below is about a turn that never ran rather than
    // about a run that quietly succeeded.
    expect(failed.map((error) => error.message)).toEqual([
      "connection terminated unexpectedly",
    ]);
    expect(marked).toEqual([]);
  });

  test("a message naming more bytes than a turn may inline refuses the turn", async () => {
    /*
     * `MAX_INLINED_BYTES_PER_RUN` bounded only the half of a run that could degrade: both places
     * that stopped spending tested `onMissing === "note"`, and the message being asked about is
     * resolved under `"fail"`, so nothing capped it at all. A member naming two hundred
     * previously-sent 8 MiB attachments in one message inlined about 1.6 GiB, plus its base64, in a
     * single turn — the heap exhaustion this budget exists to prevent, through the one door it left
     * open. End to end rather than in `attachment-parts.test.ts` alone, because what was wrong was
     * the pairing of the budget with the strict mode, and only this file wires the two together.
     *
     * Sized off the constant rather than off a literal, so raising the budget moves this test with
     * it instead of quietly making it assert nothing. Five quarters of the budget on ONE message:
     * four fit exactly, and the fifth is what there is no room for.
     */
    const quarter = MAX_INLINED_BYTES_PER_RUN / 4;
    const big = { ...stored, bytes: Buffer.alloc(quarter) };
    const names = ["one.png", "two.png", "three.png", "four.png", "five.png"];
    const asking = {
      id: "m1",
      role: "user" as const,
      content: names.map((filename, index) => ({
        type: "image",
        source: { type: "url", value: `/api/attachments/a${index}` },
        metadata: { attachmentId: `a${index}`, filename },
      })),
    };

    const loaded: string[] = [];
    const agent = await builtInWith(async (id) => {
      loaded.push(id);
      return big;
    });

    const error = await runToError(agent, input([asking]));

    // A sentence naming the problem, not a truncated turn: the file, the limit, and something to do
    // about it, because the message is still in front of the person who wrote it.
    expect(error.message).toContain('"five.png"');
    expect(error.message).toContain("could not be included");
    expect(error.message).toContain(String(MAX_INLINED_BYTES_PER_RUN));
    expect(error.message).toContain("Send fewer files");

    // And the part it refused over was never read. A turn about to be refused should not pay for
    // the bytes it cannot afford on the way to saying so.
    expect(loaded).toEqual(["a0", "a1", "a2", "a3"]);
  });

  /*
   * THE RUN'S OWN CONVERSATION REACHES BOTH SEAMS, which is the half of the channel scope that
   * lives in this file and cannot be tested from the other side.
   *
   * `loadAttachmentForTurn` and `markAttachmentsSent` refuse a file belonging to a different
   * channel by resolving the thread they are given to its channel. That is worth nothing if the
   * thread they are given is not the thread the run is in — and a fix spanning three files can
   * half-land and still look green, because every test on the database side passes whatever thread
   * it likes and every test on this side used to ignore the argument entirely. This is the seam
   * where the two halves meet: `inlineAttachments` takes the thread from `input`, and a wiring that
   * passed a constant, a stale capture, or the run id would satisfy the types and break the scope
   * in the direction that fails open.
   *
   * Both seams, because they are wired separately: the loader through `resolveAttachmentParts`
   * (which narrows to `(id) => …`, so the binding is hand-written) and the stamp directly.
   */
  test("the run's own thread is what both attachment seams are asked about", async () => {
    const loadedOn: string[] = [];
    const markedOn: string[] = [];
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (_id: string, threadId: string) => {
        loadedOn.push(threadId);
        return stored;
      },
      async (_ids: readonly string[], threadId: string) => {
        markedOn.push(threadId);
      },
    );

    const failed = await runToCompletion(
      built(agents, "general-assistant"),
      input(twoTurns),
    );
    expect(failed).toEqual([]);

    // `input()` runs on "thread_1". Both messages in `twoTurns` carry a file, so the loader is
    // asked twice, and the stamp once — for the message being asked about.
    expect(loadedOn).toEqual(["thread_1", "thread_1"]);
    expect(markedOn).toEqual(["thread_1"]);
  });

  test("a send that could not be recorded refuses the turn before the model sees it", async () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE, and the assertion it made was the bug.
     *
     * `MarkAttachmentsSent` promised that a failure to record was swallowed, because "a turn is
     * somebody waiting for an answer". The waiting is real. What the sentence quietly assumed is
     * that by the time the stamp runs, the answer has been earned — and it has not. `markSent` is
     * the last thing `inlineAttachments` does BEFORE returning the history, and the history is what
     * the run is given afterwards. So the swallow bought an answer at the price of the FILE:
     * `attachedAt` stayed null, the culler reclaimed the row a day later, and the message went on
     * displaying an attachment that no longer existed.
     *
     * Refusing instead costs a turn that never started. The two assertions below are that trade,
     * stated as facts rather than as an argument: the run errors, and `BuiltInAgent.run` was never
     * reached — so no model was called, no token was spent, and the person's message is still in
     * front of them to send again. `runToCompletion`'s spy standing in for the model is what makes
     * the second one observable; `seen` staying empty is the whole claim about WHEN this happens.
     *
     * A readable sentence, because there is no `app.onError` behind this server: what a rejected run
     * carries is what the composer shows, so an implementation's message has to name the file and
     * say what to do. This one is the test's own, since the production wording lives in
     * channels/attachments.ts and is pinned there.
     */
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => stored,
      async (ids: readonly string[]) => {
        throw new Error(
          `This turn was not run, because an attachment on your message could not be recorded as sent ("${ids.join('", "')}").`,
        );
      },
    );

    const seen: RunAgentInput[] = [];
    const failed = await runToCompletion(
      built(agents, "general-assistant"),
      input(twoTurns),
      (received) => {
        seen.push(received);
      },
    );

    expect(failed.map((error) => error.message)).toEqual([
      'This turn was not run, because an attachment on your message could not be recorded as sent ("abc").',
    ]);
    // The turn was not yet spent, which is the whole reason refusing here is the cheaper loss. Put
    // the `markSent` call after the run instead of before it and this is the assertion that goes red.
    expect(seen).toEqual([]);
  });

  /*
   * AND THE SEAM DOES NOT DRESS THE REFUSAL UP, which is what the `try`/`catch` that used to stand
   * around this call did to a synchronous throw as much as to a rejection.
   *
   * `MarkAttachmentsSent` is an optional parameter four wirings expose — `buildAgents`,
   * `resolveRuntimeAgents`, `createRequestAgents` and `mountCopilotRuntime` — so an implementation
   * that throws before it ever returns a promise is a shape this seam has to carry, and it has to
   * carry it WITHOUT replacing the message: the words that reach the person are the ones from the
   * implementation that knows which rows are involved.
   */
  test("an implementation that throws synchronously still refuses with its own words", async () => {
    const agents = await buildAgents(
      [assistant],
      model,
      "openai-secret",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => stored,
      // Not `async`: this throws on the call itself rather than returning a rejected promise, which
      // is the case a `.catch()` on the result would never have seen at all.
      (): Promise<void> => {
        throw new Error("the pool had nothing left to give");
      },
    );

    const seen: RunAgentInput[] = [];
    const failed = await runToCompletion(
      built(agents, "general-assistant"),
      input(twoTurns),
      (received) => {
        seen.push(received);
      },
    );

    expect(failed.map((error) => error.message)).toEqual([
      "the pool had nothing left to give",
    ]);
    expect(seen).toEqual([]);
  });

  test("a stored image on a document part reaches the model as an image", async () => {
    /*
     * End to end, because the unit test for this can only prove `resolvePart` does the right thing
     * with arguments a test chose. What matters is that the run hands the provider an `image` part:
     * `photo.png` renamed and dragged out of an editor claims `text/plain`, the SDK fixes the
     * modality to `document` from that claim before the upload, and the server sniffs the bytes and
     * stores `image/png`. Reading `part.type` here ran a PNG through `toString("utf8")` and
     * captioned the noise `Attached file "photo.png":`.
     */
    const agent = await builtInWith(async () => stored);

    const seen: RunAgentInput[] = [];
    const failed = await runToCompletion(
      agent,
      input([
        {
          id: "m1",
          role: "user" as const,
          content: [
            {
              type: "document",
              source: { type: "url", value: "/api/attachments/abc" },
              metadata: { attachmentId: "abc", filename: "photo.png" },
            },
          ],
        },
      ]),
      (received) => {
        seen.push(received);
      },
    );

    expect(failed).toEqual([]);
    const part = (
      seen[0]?.messages?.[0] as {
        content?: { type?: string; source?: { mimeType?: string } }[];
      }
    )?.content?.[0];
    expect(part?.type).toBe("image");
    expect(part?.source?.mimeType).toBe("image/png");
  });

  test("the run's byte budget is spent newest-first, so it is the oldest history that is cut", async () => {
    /*
     * Nothing bounded a turn before this. `MAX_IMAGE_BYTES` bounds one file, but history is
     * replayed on every turn, so a channel that had seen a few large images read and base64-ed all
     * of them again on every later turn — and that failure arrives as the pod's heap, taking every
     * other person's in-flight run with it, rather than as anything a person can read.
     *
     * Sized off `MAX_INLINED_BYTES_PER_RUN` rather than off a literal, so raising the budget moves
     * this test with it instead of quietly making it assert nothing. Five messages of a quarter of
     * the budget each: the newest four fit, and the oldest is what runs out.
     */
    const quarter = MAX_INLINED_BYTES_PER_RUN / 4;
    const big = { ...stored, bytes: Buffer.alloc(quarter) };
    const history = [
      attached("h1", "one.png", "m1"),
      attached("h2", "two.png", "m2"),
      attached("h3", "three.png", "m3"),
      attached("h4", "four.png", "m4"),
      attached("h5", "five.png", "m5"),
    ];

    const loaded: string[] = [];
    const agent = await builtInWith(async (id) => {
      loaded.push(id);
      return big;
    });

    const seen: RunAgentInput[] = [];
    const failed = await runToCompletion(agent, input(history), (received) => {
      seen.push(received);
    });

    expect(failed).toEqual([]);
    const messages = seen[0]?.messages ?? [];

    // The oldest is a note that does NOT say the file is gone — it is still there, and asking about
    // it directly would make it the message being asked about, which is charged first.
    expect((messages[0] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: '[attachment "one.png" from an earlier message was not included in this turn]',
      },
    ]);
    // And it was never read: the point of the budget is the round trip it does not make, not just
    // the base64 it does not build.
    expect(loaded).not.toContain("h1");
    expect(loaded.length).toBe(4);

    // The message being asked about is whole, which is the property that makes a budget defensible
    // at all — a person is never told their own question's attachment was left out of their turn.
    expect(
      (messages[4] as { content?: { source?: unknown }[] }).content?.[0]
        ?.source,
    ).toMatchObject({ type: "data" });
  });
});
