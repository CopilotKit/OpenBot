import { expect, test } from "bun:test";

test("Mastra's maintained AG-UI bridge consumes the catalog and both learned tool results", async () => {
  const seen: unknown[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      seen.push(body);
      const history = JSON.stringify(body.messages);
      const done = history.includes("SUPPORTING_FILE_CONTENT");
      const name = history.includes("LOADED_SKILL_CONTENT")
        ? "copilotkit_read_skill_file"
        : "copilotkit_load_skill";
      const delta = done
        ? { role: "assistant", content: "SUPPORTING_FILE_CONTENT" }
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
                    ...(name === "copilotkit_read_skill_file"
                      ? { path: "supporting.txt" }
                      : {}),
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
              finish_reason: done ? "stop" : "tool_calls",
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
  const script = `
    import { getLocalAgents } from "@ag-ui/mastra";
    import { lastValueFrom, toArray } from "rxjs";
    import { mastra } from "../agent-mastra/src/mastra/index.ts";
    import { RemoteLearnedSkillsMiddleware } from "./src/learning/remote.ts";
    const tools = ["copilotkit_load_skill", "copilotkit_read_skill_file"].map(name => ({
      name, description: "Read learned guidance", parameters: {
        type: "object", properties: { skill_name: { type: "string" }, path: { type: "string" } }, required: ["skill_name"]
      }
    }));
    const remote = getLocalAgents({ mastra, resourceId: "learning-test" }).openbot;
    const middleware = new RemoteLearnedSkillsMiddleware("bot", async () => ({
      catalog: "LEARNED_CATALOG_MARKER", tools,
      execute: async (name) => name === "copilotkit_load_skill" ? "LOADED_SKILL_CONTENT" : "SUPPORTING_FILE_CONTENT"
    }));
    const events = await lastValueFrom(middleware.run({
      threadId: crypto.randomUUID(), runId: crypto.randomUUID(), tools: [], context: [], state: {}, forwardedProps: {},
      messages: [{ id: "user", role: "user", content: "Apply the refund policy" }]
    }, remote).pipe(toArray()));
    console.log(JSON.stringify(events));
  `;
  const child = Bun.spawn([Bun.argv[0], "--no-env-file", "-e", script], {
    cwd: `${import.meta.dir}/..`,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      BOT_PROVIDER: "openai",
      BOT_MODEL: "gpt-4.1-mini",
      OPENAI_API_KEY: "synthetic-key",
      OPENAI_BASE_URL: `${provider.url}v1`,
      MASTRA_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
      NODE_ENV: "test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout).not.toContain('"RUN_ERROR"');
    expect(seen).toHaveLength(3);
    expect(JSON.stringify(seen[0])).toContain("LEARNED_CATALOG_MARKER");
    expect(JSON.stringify(seen[1])).toContain("LOADED_SKILL_CONTENT");
    expect(JSON.stringify(seen[2])).toContain("SUPPORTING_FILE_CONTENT");
    expect(stdout).toContain('"TOOL_CALL_RESULT"');
    expect(stdout).toContain("SUPPORTING_FILE_CONTENT");
  } finally {
    clearTimeout(timeout);
    child.kill();
    await provider.stop(true);
  }
}, 20_000);
