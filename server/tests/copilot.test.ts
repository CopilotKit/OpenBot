import { describe, expect, spyOn, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import {
  buildAgents,
  builtInAgentConfiguration,
  createRequestAgents,
  registeredAgentFromRow,
  resolveRuntimeAgents,
  standingRoleMessage,
} from "../src/copilot";

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
        { provider: "openai", defaultModel: "gpt-4.1" },
        "openai-secret",
      ),
    ).toEqual({
      model: "openai/gpt-4.1",
      prompt: "Be helpful.",
      apiKey: "openai-secret",
    });
  });

  test("fails an unavailable built-in agent through the AG-UI lifecycle", async () => {
    const agents = buildAgents(
      [
        {
          id: "general-assistant",
          name: "General Assistant",
          type: "built_in",
          systemPrompt: "Be helpful.",
        },
      ],
      { provider: "openai", defaultModel: "gpt-4.1" },
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

  test("constructs built-in and remote agents together", () => {
    const agents = buildAgents(
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
      { provider: "openai", defaultModel: "gpt-4.1" },
      "openai-secret",
    );

    expect(agents["general-assistant"]).toBeInstanceOf(BuiltInAgent);
    expect(agents.risk).toBeInstanceOf(HttpAgent);
  });

  /*
   * The watch goes on the fetch of a remote Bot and nowhere else.
   *
   * A built-in agent talks to a model provider through the AI SDK rather than over an AG-UI stream,
   * so there is no response body here to watch and nothing for the guard to be given. Asserting the
   * Bot's own name reaches it matters because that name is what the person is shown when its stream
   * goes quiet, and a guard handed the wrong one would say so convincingly.
   */
  test("hands a remote Bot's fetch to the stall guard, and a built-in Bot none", () => {
    const watched: { id: string; name: string }[] = [];
    const stallGuard = {
      watch: (bot: { id: string; name: string }) => {
        watched.push(bot);
        return async () => new Response(null);
      },
      stop: () => undefined,
    };

    const agents = buildAgents(
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
      { provider: "openai", defaultModel: "gpt-4.1" },
      "openai-secret",
      stallGuard,
    );

    expect(watched).toEqual([{ id: "risk", name: "Risk" }]);
    expect(agents.risk).toBeInstanceOf(HttpAgent);
  });

  test("leaves a remote Bot's fetch alone when no timeout is configured", () => {
    const agents = buildAgents(
      [
        {
          id: "risk",
          name: "Risk",
          type: "remote_ag_ui",
          endpoint: "http://risk.internal/ag-ui",
        },
      ],
      { provider: "openai", defaultModel: "gpt-4.1" },
      null,
    );

    const remote = agents.risk;
    if (!(remote instanceof HttpAgent)) {
      throw new Error("Expected the remote agent");
    }
    // @ag-ui/client defaults this to its own fetch when the config does not carry one.
    expect(typeof remote.fetch).toBe("function");
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
      { provider: "openai", defaultModel: "gpt-4.1" },
      resolveModelApiKey,
    );
    const second = await resolveRuntimeAgents(
      async () => registered,
      { provider: "openai", defaultModel: "gpt-4.1" },
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
      { provider: "openai", defaultModel: "gpt-4.1" },
      async () => {
        resolverInvoked = true;
        throw new Error("corrupt model credential");
      },
    );

    expect(agents.risk).toBeInstanceOf(HttpAgent);
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
      ].join("\n\n"),
    });
  });

  test("sends one standing role message ahead of the conversation", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const agents = buildAgents(
      [remoteAgent(endpoint.url)],
      { provider: "openai", defaultModel: "gpt-4.1" },
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
    const agents = buildAgents(
      [remoteAgent(endpoint.url)],
      { provider: "openai", defaultModel: "gpt-4.1" },
      null,
    );

    const agent = agents.agent_expense;
    agent?.setMessages([userMessage("Sort these.")]);
    await agent?.runAgent();

    const sent = endpoint.requests.at(-1);
    expect(JSON.stringify(sent?.forwardedProps ?? {})).not.toContain(
      "standing-role",
    );
    expect(JSON.stringify(sent?.state ?? {})).not.toContain("standing-role");
  });

  test("resolves a deleted coworker as a tombstone that never reaches its endpoint", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const agents = buildAgents(
      [
        {
          id: "agent_expense",
          name: "Expense Manager",
          type: "unavailable",
          reason: "Expense Manager has been deleted.",
        },
      ],
      { provider: "openai", defaultModel: "gpt-4.1" },
      null,
    );

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(agents.agent_expense?.runAgent()).rejects.toThrow(
        "Expense Manager has been deleted.",
      );
    } finally {
      consoleError.mockRestore();
    }
    // A tombstone exists so Intelligence can restore the thread, not so it can run.
    expect(agents.agent_expense).toBeDefined();
    expect(endpoint.requests).toEqual([]);
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
      { provider: "openai", defaultModel: "gpt-4.1" },
      async () => null,
    );

    const request = new Request("http://openbot.test/api/copilotkit");
    const resolved = await factory({ request });

    expect(seen.request).toBe(request);
    expect(seen.actors).toEqual([{ id: "user-7", role: "user" }]);
    expect(resolved.agent_expense).toBeInstanceOf(HttpAgent);
  });

  test("rebuilds each agent from the loader so an edited role applies to the next run", async () => {
    let roleDescription = "Review receipts.";
    const factory = createRequestAgents(
      async () => ({ id: "user-7", role: "user" as const }),
      async () => [
        remoteAgent("http://coworker.internal/ag-ui", { roleDescription }),
      ],
      { provider: "openai", defaultModel: "gpt-4.1" },
      async () => null,
    );
    const request = new Request("http://openbot.test/api/copilotkit");

    const before = await factory({ request });
    roleDescription = "Reconcile corporate card statements.";
    const after = await factory({ request });

    expect(before.agent_expense).not.toBe(after.agent_expense);
    expect(standingRoleMessage({ ...profile, roleDescription }).content).toBe(
      [
        "You are Expense Manager, Finance Operations.",
        "Reconcile corporate card statements.",
        "This standing role applies in every channel. Treat channel messages as task-specific instructions within it.",
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
