import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The compose healthcheck asks `/health`, and `/health` answers without consulting the model key.
 * The refusal to run without one therefore has to happen before the server listens: a Bot that
 * cannot answer should not be running, let alone reporting healthy. These spawn the real
 * entrypoint with the environment compose would hand it.
 */

async function startBot(environment: Record<string, string>) {
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "agent-bot", "src", "index.ts")],
    {
      // Every variable the repository's `.env` could inject is named explicitly: bun loads that
      // file into the child, and a leaked token or key would let a configuration under test pass
      // a check it is supposed to fail.
      env: {
        PATH: process.env.PATH ?? "",
        MANAGED_AGENT_TOKEN: "",
        OPENAI_API_KEY: "",
        ...environment,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Both configurations under test exit before the server listens. If one reaches `serve` anyway,
  // kill it so the test fails on the missing refusal rather than on bun's test timeout.
  const killer = setTimeout(() => proc.kill(), 5_000);
  const exitCode = await proc.exited;
  clearTimeout(killer);
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

test("agent-bot refuses to start when the model key is empty", async () => {
  // Compose passes `${OPENAI_API_KEY:-}`, so an unset key arrives as an empty
  // string rather than missing altogether.
  const { exitCode, stderr } = await startBot({
    MANAGED_AGENT_TOKEN: "test-token",
    OPENAI_API_KEY: "",
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("OPENAI_API_KEY is not set");
});

test("agent-bot still refuses to start without its server token", async () => {
  const { exitCode, stderr } = await startBot({
    OPENAI_API_KEY: "sk-test",
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("MANAGED_AGENT_TOKEN is not set");
});
