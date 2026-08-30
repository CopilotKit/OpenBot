import { describe, expect, spyOn, test } from "bun:test";
import type { AbstractAgent, RunAgentInput } from "@ag-ui/client";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { PROVENANCE_GUIDANCE } from "../../shared/bot-prompt";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import {
  buildAgents,
  builtInAgentConfiguration,
  createRequestAgents,
  type mountCopilotRuntime,
  registeredAgentFromRow,
  resolveRuntimeAgents,
  standingRoleMessage,
} from "../src/copilot";
import { grantedToolGuidance } from "../src/plugins/tools";

test("mountCopilotRuntime preserves the positional custom base path", () => {
  const customBasePath: Parameters<typeof mountCopilotRuntime>[4] =
    "/custom/copilotkit";
  expect(customBasePath).toBe("/custom/copilotkit");
});

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
    expect(agents.risk?.agentId).toBe("risk");
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
    expect(agents.risk?.agentId).toBe("risk");
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
    let dialled = 0;
    const dialler = async (_url: string, request: RequestInit) => {
      dialled += 1;
      return completeAgUiResponse(request);
    };
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
    if (!plain) throw new Error("Expected the remote agent");
    await runDirect(plain);
    expect(dialled).toBe(1);

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
    expect(watched?.agentId).toBe("risk");
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
    let dialled = 0;
    const dialler = async (_url: string, request: RequestInit) => {
      dialled += 1;
      return completeAgUiResponse(request);
    };
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
    if (!risk) throw new Error("Expected the remote agent");
    await runDirect(risk);
    expect(dialled).toBe(1);
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
    let guardedCalls = 0;
    let unguardedCalls = 0;
    const sentinel = async (_url: string, request: RequestInit) => {
      guardedCalls += 1;
      return completeAgUiResponse(request);
    };
    const ordinary = async (_url: string, request: RequestInit) => {
      unguardedCalls += 1;
      return completeAgUiResponse(request);
    };
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
    const unguarded = (
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
        ordinary,
      )
    ).risk;
    if (!guarded || !unguarded) throw new Error("Expected remote agents");
    await runDirect(guarded);
    await runDirect(unguarded);
    expect(guardedCalls).toBe(1);
    expect(unguardedCalls).toBe(1);
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

    expect(agents.risk?.agentId).toBe("risk");
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
    await agent?.runAgent();

    const sent = endpoint.requests.at(-1);
    expect(JSON.stringify(sent?.forwardedProps ?? {})).not.toContain(
      "standing-role",
    );
    expect(JSON.stringify(sent?.state ?? {})).not.toContain("standing-role");
  });

  test("resolves a deleted coworker as a tombstone that never reaches its endpoint", async () => {
    await using endpoint = fakeAgUiEndpoint();
    const agents = await buildAgents(
      [
        {
          id: "agent_expense",
          name: "Expense Manager",
          type: "unavailable",
          reason: "Expense Manager has been deleted.",
        },
      ],
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
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
      createActorAgentResolver({
        loadAgents: async (actor) => {
          seen.actors.push(actor);
          return [remoteAgent("http://coworker.internal/ag-ui")];
        },
        model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
        resolveModelApiKey: async () => null,
      }),
    );

    const request = new Request("http://openbot.test/api/copilotkit");
    const resolved = await factory({ request });

    expect(seen.request).toBe(request);
    expect(seen.actors).toEqual([{ id: "user-7", role: "user" }]);
    expect(resolved.agent_expense?.agentId).toBe("agent_expense");
  });

  test("rebuilds each agent from the loader so an edited role applies to the next run", async () => {
    let roleDescription = "Review receipts.";
    const factory = createRequestAgents(
      async () => ({ id: "user-7", role: "user" as const }),
      createActorAgentResolver({
        loadAgents: async () => [
          remoteAgent("http://coworker.internal/ag-ui", { roleDescription }),
        ],
        model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
        resolveModelApiKey: async () => null,
      }),
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

async function runDirect(agent: AbstractAgent) {
  const input: RunAgentInput = {
    threadId: "direct-thread",
    runId: "direct-run",
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  };
  await new Promise<void>((resolve, reject) => {
    agent.run(input).subscribe({ complete: resolve, error: reject });
  });
}

function completeAgUiResponse(request: RequestInit) {
  const input = JSON.parse(String(request.body)) as {
    threadId: string;
    runId: string;
  };
  return new Response(
    [
      { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
      { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
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
