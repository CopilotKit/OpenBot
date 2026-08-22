import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { buildAGUITextResponse, LLMock } from "@copilotkit/aimock";
import { AGUIMock } from "@copilotkit/aimock/agui";
import { z } from "zod";
import {
  buildAgents,
  type RegisteredAgent,
  type RuntimeModel,
} from "../src/copilot";
import type { Selection } from "../src/plugins/selection";
import type { GrantedTool } from "../src/plugins/tools";
import { createModelCompleter } from "../src/routing/model";

/**
 * Tool selection, asserted on the bytes that reach the model rather than on the decision.
 *
 * The unit tests next door prove `selectTools` narrows correctly. They cannot prove the narrowing
 * arrives: the tools are attached at agent construction, the runtime clones the agent before every
 * run, and both of those sit between the decision and the request. So this drives the real
 * `buildAgents`, through a real clone, against `@copilotkit/aimock` — ours, the org's deterministic
 * backend — and reads the tool list out of the request the mock actually received. If the agent were
 * built with the whole catalogue, or the clone lost the wrapper, or pass one never happened, the
 * decision would still be right and every one of these would fail.
 *
 * Both paths are covered because they attach tools differently and would break separately: a
 * built-in Bot carries them in its configuration, a remote one is sent them in the AG-UI run body.
 */

const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };

/** Sixteen tools across two servers: over the floor, so selection has something to do. */
const granted: GrantedTool[] = [
  ...Array.from({ length: 8 }, (_, index) => grantedTool("drive", index)),
  ...Array.from({ length: 8 }, (_, index) => grantedTool("slack", index)),
];

function grantedTool(server: string, index: number): GrantedTool {
  const ref = `${server}/tool_${index}`;
  return {
    ref,
    name: `mcp__${server}__tool_${index}`,
    description: `${server} tool ${index}`,
    parameters: z.object({ q: z.string() }),
    execute: async () => "ok",
  };
}

const skills = [
  {
    slug: "drive-audit",
    title: "Drive audit",
    summary: "Read documents out of Google Drive.",
    tools: ["drive/tool_0", "drive/tool_1"],
  },
  {
    slug: "slack-digest",
    title: "Slack digest",
    summary: "Summarise Slack channels.",
    // Every Slack tool, so a Slack tool being offered can only mean this skill was chosen.
    tools: Array.from({ length: 8 }, (_, index) => `slack/tool_${index}`),
  },
];

const llm = new LLMock();
const remote = new AGUIMock();
let remoteUrl = "";
/** Every AG-UI run the mock received, as the endpoint saw it. */
let sentToRemote: {
  tools: string[];
  messages: { id?: string; role?: string; content?: unknown }[];
  forwardedProps: Record<string, unknown>;
}[] = [];

beforeAll(async () => {
  const url = await llm.start();
  process.env.OPENAI_BASE_URL = url;
  process.env.OPENAI_API_KEY = "test-key";

  remote.onPredicate(
    (input) => {
      sentToRemote.push({
        tools: ((input.tools ?? []) as { name?: string }[])
          .map((tool) => tool.name ?? "")
          .filter(Boolean),
        messages: (input.messages ?? []) as never,
        forwardedProps: (input.forwardedProps ?? {}) as Record<string, unknown>,
      });
      return true;
    },
    // Built rather than hand-written: the events carry the run and thread ids the protocol requires,
    // and the client verifies them, so a hand-rolled sequence fails validation rather than the test.
    buildAGUITextResponse("done") as never,
  );
  remoteUrl = await remote.start();
});

afterAll(async () => {
  await llm.stop();
  await remote.stop();
});

beforeEach(() => {
  llm.clearRequests();
  llm.clearFixtures();
  sentToRemote = [];
});

/**
 * Pass one answers with `chosen`, and the run itself answers with prose.
 *
 * Ordered: the selection prompt is matched first by its own opening line, and everything else falls
 * through to the second fixture. Matching pass one on text the prompt actually contains is the point
 * — if the prompt is ever rewritten without it, this stops matching and the tests fail loudly rather
 * than quietly testing the un-narrowed path.
 */
function answerWith(chosen: string[]) {
  llm.onMessage(/You choose which capabilities to load/, {
    type: "text",
    content: JSON.stringify({ skills: chosen }),
  });
  llm.onMessage(/.*/, { type: "text", content: "Here is what I found." });
}

const recorded: Selection<GrantedTool>[] = [];

function selection(overrides: { floor?: number } = {}) {
  return {
    loadSkills: async () => skills,
    choose: createModelCompleter({
      model,
      resolveApiKey: async () => "test-key",
    }),
    record: async (_botId: string, entry: Selection<GrantedTool>) => {
      recorded.push(entry);
    },
    ...overrides,
  };
}

const builtIn: RegisteredAgent = {
  id: "analyst",
  name: "Analyst",
  type: "built_in",
  systemPrompt: "You are an analyst.",
};

const remoteAgent = (): RegisteredAgent => ({
  id: "risk",
  name: "Risk",
  type: "remote_ag_ui",
  endpoint: `${remoteUrl}/`,
  standingMessage: {
    id: "standing-role:risk",
    role: "system",
    content: "You are Risk.",
  },
});

/**
 * Run one Bot the way the runtime does, including the clone.
 *
 * `agents[agentId].clone()` is what the runtime calls before every run, and `AbstractAgent.clone`
 * copies a fixed list of its own fields onto a bare object — it knows nothing about a subclass. A
 * wrapper that did not carry its own state across would fail here and nowhere else.
 */
async function ask(agent: { clone: () => unknown }, text: string) {
  const running = (agent.clone as () => never)() as unknown as {
    addMessage: (message: unknown) => void;
    runAgent: () => Promise<unknown>;
  };
  running.addMessage({ id: `m-${text.length}`, role: "user", content: text });
  await running.runAgent();
}

/** The tool names in the last request the model actually received for a run (not for pass one). */
function toolsOfferedToModel(): string[] {
  const runs = llm
    .getRequests()
    .filter((entry) =>
      Array.isArray((entry.body as { tools?: unknown })?.tools),
    );
  const last = runs.at(-1);
  return (
    (last?.body as { tools?: { function?: { name?: string } }[] })?.tools ?? []
  )
    .map((tool) => tool.function?.name ?? "")
    .filter((name) => name.startsWith("mcp__"));
}

describe("a built-in Bot", () => {
  test("is offered the chosen skill's tools and the tools no skill claims", async () => {
    answerWith(["drive-audit"]);
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      selection(),
    );

    await ask(
      agents.analyst as never,
      "what is in the quarterly report in Drive",
    );

    const offered = toolsOfferedToModel();
    // Declared by the chosen skill.
    expect(offered).toContain("mcp__drive__tool_0");
    expect(offered).toContain("mcp__drive__tool_1");
    // Granted, and claimed by no skill at all, so still offered.
    expect(offered).toContain("mcp__drive__tool_7");
    // Declared only by the skill that was not chosen. This is the narrowing.
    expect(offered).not.toContain("mcp__slack__tool_0");
    expect(offered).not.toContain("mcp__slack__tool_7");
    expect(offered).toHaveLength(8);
  });

  test("pass one really happened, against the real endpoint", async () => {
    answerWith(["drive-audit"]);
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      selection(),
    );
    await ask(agents.analyst as never, "read the Drive doc");

    const prompts = llm
      .getRequests()
      .flatMap((entry) =>
        ((entry.body as { messages?: { content?: unknown }[] })?.messages ?? [])
          .map((message) => message.content)
          .filter((content): content is string => typeof content === "string"),
      );
    expect(
      prompts.some((prompt) =>
        prompt.includes("You choose which capabilities to load"),
      ),
    ).toBe(true);
  });

  test("both skills chosen offers both their tools", async () => {
    answerWith(["drive-audit", "slack-digest"]);
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      selection(),
    );
    await ask(
      agents.analyst as never,
      "compare the Drive doc with the Slack thread",
    );

    const offered = toolsOfferedToModel();
    expect(offered).toContain("mcp__drive__tool_0");
    expect(offered).toContain("mcp__slack__tool_0");
    expect(offered).toHaveLength(granted.length);
  });

  test("a model that cannot answer costs the narrowing and not the tools", async () => {
    // No fixture for the selection prompt: aimock has nothing to serve, so pass one fails the way a
    // real outage does, and the run has to carry on with everything.
    llm.onMessage(/.*/, { type: "text", content: "Here is what I found." });
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      {
        loadSkills: async () => skills,
        choose: async () => {
          throw new Error("model unreachable");
        },
      },
    );
    await ask(agents.analyst as never, "read the Drive doc");

    expect(toolsOfferedToModel()).toHaveLength(granted.length);
  });

  test("the guidance names only what the run was offered", async () => {
    answerWith(["drive-audit"]);
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      selection(),
    );
    await ask(agents.analyst as never, "read the Drive doc");

    const runs = llm
      .getRequests()
      .filter((entry) =>
        Array.isArray((entry.body as { tools?: unknown })?.tools),
      );
    const system = (
      (
        runs.at(-1)?.body as {
          messages?: { role?: string; content?: unknown }[];
        }
      )?.messages ?? []
    )
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n");
    /*
     * A Bot told it holds Slack tools it was not offered will promise Slack and then be unable to
     * do it, which reads to the person as the Bot lying rather than as a narrowing. The guidance is
     * generated from the tools passed to the configuration, so this is what proves the narrowed set
     * is the one that got there.
     */
    expect(system).toContain("drive");
    expect(system).not.toContain("slack: tool_0");
  });
});

describe("a remote Bot", () => {
  test("is sent the narrowed tools in its run body", async () => {
    answerWith(["slack-digest"]);
    const agents = await buildAgents(
      [remoteAgent()],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      selection(),
    );
    await ask(agents.risk as never, "summarise the Slack channel");

    expect(sentToRemote).toHaveLength(1);
    const offered = (sentToRemote[0]?.tools ?? []).filter((name) =>
      name.startsWith("mcp__"),
    );
    expect(offered).toContain("mcp__slack__tool_0");
    // Declared by the skill that was not chosen.
    expect(offered).not.toContain("mcp__drive__tool_0");
    // Undeclared, so it rides along on the remote path exactly as on the built-in one.
    expect(offered).toContain("mcp__drive__tool_7");
  });

  test("still gets its standing role, its holdings and its signed run", async () => {
    /*
     * THIS IS THE TEST THAT CAUGHT THE REAL BUG. Narrowing was first built by wrapping the agent and
     * delegating to `remote.run(input)`. Middleware registered with `.use()` is applied by
     * `runAgent`, not by `run`, so the whole of `remoteAgentWithStandingRole` was skipped: the
     * endpoint got a run with no role, no holdings, no tools and no signed assertion. Nothing threw.
     * The Bot simply answered as though it had been told nothing, which is exactly what had
     * happened.
     */
    answerWith(["slack-digest"]);
    const agents = await buildAgents(
      [remoteAgent()],
      model,
      "test-key",
      undefined,
      async () => granted,
      () => "signed-assertion",
      undefined,
      undefined,
      selection(),
    );
    await ask(agents.risk as never, "summarise the Slack channel");

    const run = sentToRemote[0];
    expect(run?.messages?.[0]?.id).toBe("standing-role:risk");
    const holdings = (run?.messages ?? []).find(
      (message) => message.id === "granted-tools:risk",
    );
    expect(String(holdings?.content ?? "")).toContain("slack");
    // Narrowed away, so the Bot must not be told it holds it.
    expect(String(holdings?.content ?? "")).not.toContain("drive: tool_0");
    expect(run?.forwardedProps?.openbotBotId).toBe("risk");
    expect(run?.forwardedProps?.openbotRun).toBe("signed-assertion");
    // The deployment-run list has to be the narrowed set too, or the Bot is told this side executes
    // a tool it was never offered.
    expect(run?.forwardedProps?.openbotDeploymentTools).toContain(
      "mcp__slack__tool_0",
    );
    expect(run?.forwardedProps?.openbotDeploymentTools).not.toContain(
      "mcp__drive__tool_0",
    );
  });
});

describe("when selection cannot help", () => {
  test("a catalogue under the floor is never sent to pass one", async () => {
    llm.onMessage(/.*/, { type: "text", content: "Here is what I found." });
    const few = granted.slice(0, 6);
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => few,
      undefined,
      undefined,
      undefined,
      selection(),
    );
    await ask(agents.analyst as never, "read the Drive doc");

    const prompts = llm
      .getRequests()
      .flatMap((entry) =>
        (
          (entry.body as { messages?: { content?: unknown }[] })?.messages ?? []
        ).map((message) => String(message.content ?? "")),
      );
    expect(
      prompts.some((prompt) =>
        prompt.includes("You choose which capabilities to load"),
      ),
    ).toBe(false);
    expect(toolsOfferedToModel()).toHaveLength(few.length);
  });

  test("a Bot whose skills declare nothing is never sent to pass one", async () => {
    llm.onMessage(/.*/, { type: "text", content: "Here is what I found." });
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      {
        loadSkills: async () => [
          {
            slug: "prose",
            title: "Prose",
            summary: "Instructions only",
            tools: [],
          },
        ],
        choose: async () => {
          throw new Error("should not be asked");
        },
      },
    );
    await ask(agents.analyst as never, "read the Drive doc");
    expect(toolsOfferedToModel()).toHaveLength(granted.length);
  });

  test("skills that cannot be read leave the Bot with all of its tools", async () => {
    llm.onMessage(/.*/, { type: "text", content: "Here is what I found." });
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      {
        loadSkills: async () => {
          throw new Error("database is down");
        },
        choose: async () => JSON.stringify({ skills: ["drive-audit"] }),
      },
    );
    await ask(agents.analyst as never, "read the Drive doc");
    expect(toolsOfferedToModel()).toHaveLength(granted.length);
  });
});

describe("the discovery record", () => {
  test("names the narrowing, and is written before the model is asked", async () => {
    recorded.length = 0;
    answerWith(["drive-audit"]);
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      selection(),
    );
    await ask(agents.analyst as never, "read the Drive doc");

    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    expect(entry?.reason).toBe("selected");
    expect(entry?.skills).toEqual(["drive-audit"]);
    expect(entry?.granted).toBe(granted.length);
    expect(entry?.offered).toHaveLength(8);
  });

  test("a record that throws does not cost the run", async () => {
    answerWith(["drive-audit"]);
    const agents = await buildAgents(
      [builtIn],
      model,
      "test-key",
      undefined,
      async () => granted,
      undefined,
      undefined,
      undefined,
      {
        loadSkills: async () => skills,
        choose: createModelCompleter({
          model,
          resolveApiKey: async () => "test-key",
        }),
        record: async () => {
          throw new Error("audit table is gone");
        },
      },
    );
    // The assertion is that this resolves at all. An audit write is not worth a person's answer.
    await ask(agents.analyst as never, "read the Drive doc");
    expect(toolsOfferedToModel()).toHaveLength(8);
  });
});
