import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import {
  buildAgents,
  type RegisteredAgent,
  runtimeModelForEnvironment,
  type ToolSelection,
} from "../src/copilot";
import { PICKED_SKILL_PROP } from "../src/plugins/picked-skill";

/*
 * A skill picked for a built-in Bot on a Claude or ChatGPT plan reaches the model.
 *
 * FOUND ON WINDOWS. Personal edition, signed in with a Claude plan and no API key. A person picked
 * their "Tide report" skill for the Personal Assistant from the `/` menu and wrote "lighthouses";
 * the Bot answered "Unknown command: /tide-report". The skill's instructions were in the Bot's
 * prompt, which reaches the plan's harness as context. The person's message reached it as parts,
 * and the Claude harness put its one text part, "/tide-report lighthouses", last in the prompt it
 * gave Claude Code, which read it as a slash command of its own and answered without asking the
 * model. A Claude Agent SDK Bot, sent the same words as a string, followed the skill.
 *
 * Built as the Desktop builds a plan deployment (`runtimeModelForEnvironment`, as the tool chooser,
 * Auto-review and the router are), through `buildAgents`, the path a person's run takes. The harness
 * here answers over AG-UI as `agent-claude-sdk`'s `/model` and `agent-langgraph-agui` do, and keeps
 * what it was sent.
 */

const SKILL_TEXT =
  "Answer with the tide times for the place named, as a table. TIDE-7731";

type HarnessBody = {
  threadId: string;
  runId: string;
  messages: Message[];
  context: { description: string; value: string }[];
  forwardedProps: Record<string, unknown>;
};
const requests: { path: string; body: HarnessBody }[] = [];

const harness = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/cancel")) return Response.json({ ok: true });
    const body = (await request.json()) as HarnessBody;
    requests.push({ path, body });
    const events = [
      { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
      { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "answer",
        delta: "| Time | Height |",
      },
      { type: "TEXT_MESSAGE_END", messageId: "answer" },
      { type: "RUN_FINISHED", threadId: body.threadId, runId: body.runId },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

const saved = {
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
};
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
afterAll(() => {
  if (saved.openai !== undefined) process.env.OPENAI_API_KEY = saved.openai;
  if (saved.anthropic !== undefined)
    process.env.ANTHROPIC_API_KEY = saved.anthropic;
  harness.stop(true);
});
beforeEach(() => {
  requests.length = 0;
});

/** What OpenBot Desktop writes for each plan: its credential, the installed harness, no key. */
const plans = {
  claude: {
    CLAUDE_CODE_OAUTH_TOKEN: "plan-token-the-server-never-reads",
    PICKED_HARNESS_IMAGE: "ghcr.io/copilotkit/openbot-agent-claude-sdk:0.3.3",
  },
  chatgpt: {
    CHATGPT_AUTH_FILE: "/run/openbot/chatgpt-auth.json",
    PICKED_HARNESS_IMAGE:
      "ghcr.io/copilotkit/openbot-agent-langgraph-agui:0.3.3",
  },
} as const;

const assistant: RegisteredAgent = {
  id: "personal-assistant",
  name: "Personal Assistant",
  type: "built_in",
  systemPrompt:
    "Help with email, your calendar, research and everyday errands.",
};

/** The Bot's grants, as `grantedSkills` reads them: one personal skill, switched on. */
const selection: ToolSelection = {
  loadSkills: async () => [
    {
      slug: "tide-report",
      title: "Tide report",
      summary: "Tide times for a place",
      tools: [],
      instructions: SKILL_TEXT,
    },
  ],
  choose: async () => null,
};

async function asked(
  plan: keyof typeof plans,
  message: string,
  forwardedProps?: Record<string, unknown>,
) {
  const model = runtimeModelForEnvironment(
    { provider: "openai", defaultModel: "gpt-5.6-terra" },
    {
      ...plans[plan],
      PICKED_HARNESS_URL: harness.url.href,
      MANAGED_AGENT_TOKEN: "deployment-harness-token",
    },
  );
  expect(model.plan?.provider).toBe(plan);
  const agents = await buildAgents(
    [assistant],
    model,
    null,
    undefined,
    async () => [],
    undefined,
    undefined,
    undefined,
    selection,
  );
  const agent = agents[assistant.id]?.clone();
  if (!agent) throw new Error("Bot missing");
  agent.setMessages([{ id: "q", role: "user", content: message }]);
  await agent.runAgent(forwardedProps ? { forwardedProps } : undefined);
  expect(agent.messages.at(-1)).toMatchObject({ content: "| Time | Height |" });
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (!request) throw new Error("The plan's harness was never asked");
  return request;
}

/** Every text a message carries as a part of its own, which the Claude harness passes on bare. */
const bareTexts = (messages: Message[]) =>
  messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        )
      : [],
  );

describe.each([
  ["claude", "/model"],
  ["chatgpt", "/"],
] as const)("a built-in Bot on a %s plan", (plan, path) => {
  test("is sent the picked skill's instructions, and the command as words, not a bare command", async () => {
    const request = await asked(plan, "/tide-report lighthouses");
    expect(request.path).toBe(path);
    expect(request.body.forwardedProps.openbotModelOnly).toBe(true);
    // The Bot's own instructions, which both harnesses make the system prompt.
    const instructions = request.body.context
      .filter((entry) => entry.description === "Built-in Bot instructions")
      .map((entry) => entry.value)
      .join("\n");
    expect(instructions).toContain(SKILL_TEXT);
    expect(instructions).toContain('"Tide report" (/tide-report)');
    // The person's words reach the harness whole, as one string, the shape a browser sends.
    const user = request.body.messages.filter(
      (message) => message.role === "user",
    );
    expect(user.map((message) => message.content)).toEqual([
      "/tide-report lighthouses",
    ]);
    expect(
      bareTexts(request.body.messages).filter((text) =>
        text.trimStart().startsWith("/"),
      ),
    ).toEqual([]);
  });

  test("in a group conversation, is sent the skill its host stated for the turn", async () => {
    const request = await asked(
      plan,
      "You are Personal Assistant, one of several Bots in this group conversation. Answer only your own part.\n\n/tide-report lighthouses",
      { [PICKED_SKILL_PROP]: "tide-report" },
    );
    expect(JSON.stringify(request.body.context)).toContain(SKILL_TEXT);
    expect(
      bareTexts(request.body.messages).filter((text) =>
        text.trimStart().startsWith("/"),
      ),
    ).toEqual([]);
  });
});
