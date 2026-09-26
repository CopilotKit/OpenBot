import { expect, test } from "bun:test";
import { LLMock } from "@copilotkit/aimock";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { buildAgents, type RuntimeModel } from "../src/copilot";
import {
  createLearningRuntime,
  type AcquireLearnedSkills,
} from "../src/learning/runtime";
import { createLearningSettingsStore } from "../src/learning/settings";
import { skillSnapshot } from "./fixtures/learned-skills";

function agents(
  acquire: AcquireLearnedSkills,
  model: RuntimeModel = { provider: "openai", defaultModel: "gpt-4o-mini" },
) {
  return buildAgents(
    [
      {
        id: "researcher",
        name: "Researcher",
        type: "built_in",
        systemPrompt: "Use reliable public sources.",
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
    undefined,
    undefined,
    undefined,
    undefined,
    acquire,
  );
}

function learning() {
  const client = new CopilotKitIntelligence({ apiKey: "synthetic-never-sent" });
  let fetches = 0;
  client.getLearnedSkillsSnapshot = async () => {
    fetches++;
    return skillSnapshot();
  };
  return {
    runtime: createLearningRuntime({
      client,
      store: createLearningSettingsStore(undefined, {
        containerId: "public-research",
      }),
    }),
    fetches: () => fetches,
  };
}

test("real cloned built-in agent loads a published Skill and supporting file before answering", async () => {
  const mock = new LLMock();
  const old = process.env.OPENAI_BASE_URL;
  const f = learning();
  let step = 0;
  try {
    process.env.OPENAI_BASE_URL = await mock.start();
    mock.onMessage(/.*/, () => {
      step++;
      if (step === 1)
        return {
          toolCalls: [
            {
              name: "copilotkit_load_skill",
              arguments: JSON.stringify({ skill_name: "public-answer" }),
            },
          ],
        };
      if (step === 2)
        return {
          toolCalls: [
            {
              name: "copilotkit_read_skill_file",
              arguments: JSON.stringify({
                skill_name: "public-answer",
                path: "reference.txt",
              }),
            },
          ],
        };
      return {
        content: "The public supporting fact follows the published guidance.",
      };
    });
    const built = await agents(f.runtime.acquire);
    const agent = built.researcher.clone();
    agent.setMessages([
      {
        id: "question",
        role: "user",
        content: "Use the public research guidance.",
      },
    ]);
    await agent.runAgent();
    const requests = mock.getRequests();
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[0]?.body)).toContain("public-answer");
    expect(JSON.stringify(requests[1]?.body)).toContain(
      "Follow published guidance r1",
    );
    expect(JSON.stringify(requests[2]?.body)).toContain(
      "Public supporting fact r1.",
    );
    expect(agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "The public supporting fact follows the published guidance.",
    });
    const again = (await agents(f.runtime.acquire)).researcher.clone();
    again.setMessages([
      { id: "question2", role: "user", content: "Use the same guidance." },
    ]);
    await again.runAgent();
    expect(f.fetches()).toBe(1);
  } finally {
    if (old === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = old;
    await mock.stop();
  }
});

test("learned Skill catalog and server tools reach plan-backed agent models", async () => {
  const f = learning();
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      requests.push(body);
      const events = [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "answer",
          delta: "Published catalog available.",
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
  try {
    const built = await agents(f.runtime.acquire, {
      provider: "openai",
      defaultModel: "unused",
      plan: { provider: "chatgpt", endpoint: server.url, token: "synthetic" },
    });
    const agent = built.researcher.clone();
    agent.setMessages([
      { id: "request", role: "user", content: "Research the public fact." },
    ]);
    await agent.runAgent();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("public-answer");
    expect(JSON.stringify(requests[0])).toContain("copilotkit_load_skill");
    expect(JSON.stringify(requests[0])).toContain("copilotkit_read_skill_file");
    expect(JSON.stringify(requests[0])).not.toContain("synthetic-never-sent");
  } finally {
    server.stop(true);
  }
});

test("a frontend tool cannot replace the learned Skill reader", async () => {
  const f = learning();
  const built = await agents(f.runtime.acquire);
  const agent = built.researcher.clone();
  agent.setMessages([
    { id: "request", role: "user", content: "Load guidance." },
  ]);
  await expect(
    agent.runAgent({
      tools: [
        {
          name: "copilotkit_load_skill",
          description: "caller replacement",
          parameters: { type: "object", properties: {} },
        },
      ],
    }),
  ).rejects.toThrow("reserved");
});
