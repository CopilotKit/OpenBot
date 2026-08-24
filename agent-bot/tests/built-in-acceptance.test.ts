import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

const children: Bun.Subprocess[] = [];

async function freePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function startSmokeBot() {
  const port = await freePort();
  const child = Bun.spawn(
    ["bun", join(process.cwd(), "agent-bot", "src", "index.ts")],
    {
      env: {
        PATH: process.env.PATH ?? "",
        PORT: String(port),
        MANAGED_AGENT_TOKEN: "smoke-agent-token",
        OPENBOT_BUILT_IN_SMOKE_MODE: "1",
        OPENAI_API_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(child);

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      if (health.ok) return { port, process: child };
    } catch {
      // The child is still starting.
    }
    await Bun.sleep(25);
  }

  const stderr = await new Response(child.stderr).text();
  throw new Error(`smoke agent did not start: ${stderr}`);
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

test("built-in agent smoke mode serves authenticated AG-UI text without echoing payloads", async () => {
  const { port, process: child } = await startSmokeBot();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/ag-ui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(unauthorized.status).toBe(401);

  const response = await fetch(`http://127.0.0.1:${port}/ag-ui`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openbot-agent-token": "smoke-agent-token",
    },
    body: JSON.stringify({
      threadId: "thread_smoke",
      runId: "run_smoke",
      messages: [
        {
          id: "message_smoke",
          role: "user",
          content: "Return the local smoke result.",
        },
      ],
      tools: [
        {
          name: "not-allowed-in-smoke",
          description: "Must never execute in smoke mode.",
          parameters: {
            type: "object",
            properties: { payload: { type: "string" } },
          },
        },
      ],
      forwardedProps: {
        secret: "request-secret-must-not-echo",
        payload: { customer: "not-real-local-smoke-data" },
      },
    }),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);

  expect(events.map((event) => event.type)).toEqual([
    "RUN_STARTED",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED",
  ]);
  expect(events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")).toMatchObject({
    delta: "OPENBOT_BUILT_IN_SAFE_SMOKE_OK",
  });
  expect(events.every((event) => typeof event.type === "string")).toBe(true);

  const responseText = JSON.stringify(events);
  expect(responseText).not.toContain("smoke-agent-token");
  expect(responseText).not.toContain("request-secret-must-not-echo");
  expect(responseText).not.toContain("not-real-local-smoke-data");
  expect(responseText).not.toContain("not-allowed-in-smoke");

  child.kill();
  await child.exited;
});
