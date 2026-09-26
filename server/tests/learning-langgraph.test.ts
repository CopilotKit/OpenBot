import { expect, test } from "bun:test";
import { HttpAgent, type RunAgentInput, type Tool } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { RemoteLearnedSkillsMiddleware } from "../src/learning/remote";

const catalog = "Published skill refunds: use the refund procedure.";
const skill = "Load supporting.txt before answering.";
const support = "Refunds are available for 37 days.";
const load = "copilotkit_load_skill";
const read = "copilotkit_read_skill_file";
const tools: Tool[] = [load, read].map((name) => ({
  name,
  description: "Read learned guidance",
  parameters: {
    type: "object",
    properties: {
      skill_name: { type: "string" },
      ...(name === read ? { path: { type: "string" } } : {}),
    },
    required: ["skill_name", ...(name === read ? ["path"] : [])],
  },
}));

for (const framework of ["langgraph", "bot"]) {
  test(`${framework}: real provider sees the learned catalog and both server-read results`, async () => {
    const seen: {
      messages: { role: string; content: string }[];
      tools: { function: { name: string } }[];
    }[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        seen.push(body);
        const history = JSON.stringify(body.messages);
        const name = history.includes(skill) ? read : load;
        const answer = history.includes(support);
        const delta = answer
          ? { role: "assistant", content: support }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${name}`,
                  type: "function",
                  function: {
                    name,
                    arguments: JSON.stringify({
                      skill_name: "refunds",
                      ...(name === read ? { path: "supporting.txt" } : {}),
                    }),
                  },
                },
              ],
            };
        const base = {
          id: `chat-${seen.length}`,
          object: "chat.completion.chunk",
          created: 0,
          model: body.model,
        };
        const chunks = [
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: answer ? "stop" : "tool_calls",
              },
            ],
          },
        ];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const child = Bun.spawn(
      [Bun.argv[0], "--no-env-file", `agent-${framework}/src/index.ts`],
      {
        cwd: `${import.meta.dir}/../..`,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PORT: String(port),
          MANAGED_AGENT_TOKEN: "synthetic-managed-token",
          BOT_PROVIDER: "openai",
          BOT_MODEL: "gpt-4.1-mini",
          OPENAI_API_KEY: "synthetic-provider-key",
          OPENAI_BASE_URL: `${provider.url}v1`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const endpoint = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 10_000;
      let ready = false;
      while (Date.now() < deadline) {
        ready = await fetch(`${endpoint}/health`).then(
          (response) => response.ok,
          () => false,
        );
        if (ready) break;
        await Bun.sleep(50);
      }
      expect(ready).toBe(true);
      const remote = new HttpAgent({
        url: `${endpoint}/ag-ui`,
        headers: { "x-openbot-agent-token": "synthetic-managed-token" },
      });
      const middleware = new RemoteLearnedSkillsMiddleware("bot", async () => ({
        catalog,
        tools,
        execute: async (name, args) => {
          expect(args).toEqual({
            skill_name: "refunds",
            ...(name === read ? { path: "supporting.txt" } : {}),
          });
          return name === read ? support : skill;
        },
      }));
      const input: RunAgentInput = {
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        messages: [
          { id: "user", role: "user", content: "What is the refund policy?" },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: { openbotDeploymentTools: [] },
      };
      const events = await lastValueFrom(
        middleware.run(input, remote).pipe(toArray()),
      );
      expect(events.filter((event) => event.type === "RUN_ERROR")).toEqual([]);
      expect(seen).toHaveLength(3);
      expect(JSON.stringify(seen[0]?.messages)).toContain(catalog);
      expect(seen[0]?.tools.map((tool) => tool.function.name)).toEqual([
        load,
        read,
      ]);
      expect(JSON.stringify(seen[1]?.messages)).toContain(skill);
      expect(JSON.stringify(seen[2]?.messages)).toContain(support);
      expect(
        events.filter((event) => event.type === "TOOL_CALL_RESULT"),
      ).toHaveLength(2);
      expect(
        events
          .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
          .map((event) => event.delta)
          .join(""),
      ).toContain(support);
    } finally {
      child.kill();
      await child.exited;
      await provider.stop(true);
    }
  }, 20_000);
}
