import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * The Bot that ships in the box, driven over its real AG-UI contract.
 *
 * The other test here covers history parsing; nothing exercised the endpoint. This does: it starts
 * the process against a stand-in model, sends an authenticated run and an unauthenticated one, and
 * checks the three things that make the built-in Bot usable and safe — a token is required, an
 * ordinary prompt comes back as text a person can read, and neither the model key nor the Bot token
 * appears in anything the endpoint returns.
 *
 * The model is a local stand-in so the test is deterministic and needs no network or real key. Its
 * only job is to stream one chat-completion chunk of content, which is the shape agent-bot reads.
 */

const AGENT_TOKEN = "test-managed-agent-token-value";
const MODEL_KEY = "test-openai-api-key-value";
const ANSWER = "The standup is at nine. Everything is green.";

let model: ReturnType<typeof Bun.serve>;
let bot: ReturnType<typeof Bun.spawn>;
let botPort: number;

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

beforeAll(async () => {
  // A stand-in for /v1/chat/completions that streams one line of content and stops.
  model = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/chat/completions")) {
        const body = `${chunk({ role: "assistant", content: ANSWER }, null)}${chunk(
          {},
          "stop",
        )}data: [DONE]\n\n`;
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  botPort = 4288;
  bot = Bun.spawn(["bun", "src/index.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(botPort),
      MANAGED_AGENT_TOKEN: AGENT_TOKEN,
      OPENAI_API_KEY: MODEL_KEY,
      OPENAI_BASE_URL: `http://localhost:${model.port}/v1`,
      BOT_MODEL: "gpt-5.5",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Up when the status endpoint answers.
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${botPort}/`);
      if (res.ok) return;
    } catch {
      // still starting
    }
    await Bun.sleep(100);
  }
  throw new Error("agent-bot did not come up");
});

afterAll(() => {
  bot?.kill();
  model?.stop(true);
});

function run(headers: Record<string, string>) {
  return fetch(`http://localhost:${botPort}/ag-ui`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      threadId: "t1",
      runId: "r1",
      messages: [{ id: "m1", role: "user", content: "When is standup?" }],
      tools: [],
    }),
  });
}

describe("the built-in Bot's AG-UI endpoint", () => {
  test("refuses a run with no token", async () => {
    const res = await run({});
    expect(res.status).toBe(401);
    const body = await res.text();
    // The refusal says nothing about the credential it is protecting.
    expect(body).not.toContain(AGENT_TOKEN);
    expect(body).not.toContain(MODEL_KEY);
  });

  test("refuses a run with the wrong token", async () => {
    const res = await run({ "x-openbot-agent-token": "not-the-token" });
    expect(res.status).toBe(401);
  });

  test("answers an authenticated run with readable text, and leaks no secret", async () => {
    const res = await run({ "x-openbot-agent-token": AGENT_TOKEN });
    expect(res.status).toBe(200);
    const body = await res.text();

    // A person gets the model's answer back through the AG-UI stream.
    expect(body).toContain("RUN_STARTED");
    expect(body).toContain(ANSWER);

    // Neither the Bot token nor the model key is anywhere in the response.
    expect(body).not.toContain(AGENT_TOKEN);
    expect(body).not.toContain(MODEL_KEY);
  });
});
