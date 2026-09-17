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

test("agent-bot refuses a model it cannot drive however the name is spaced", async () => {
  // A variable set directly on the container — `docker run -e`, a systemd unit, a hand-written
  // Deployment — reaches the process with its whitespace intact. The startup guard anchors on the
  // start of the name, so a padded one walks past it and the silence the guard exists to prevent
  // comes back on the first tool call.
  const { exitCode, stderr } = await startBot({
    MANAGED_AGENT_TOKEN: "test-token",
    OPENAI_API_KEY: "sk-test",
    BOT_MODEL: " gpt-5.6-terra",
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("cannot be used by this Bot");
}, 10_000);

test("agent-bot falls back to its default model when the name is empty", async () => {
  // Compose substitutes on empty as well as on unset, but a container handed `BOT_MODEL=` directly
  // keeps the empty string as a value, and the Bot then asks its provider for a model named "".
  const { exitCode, stderr } = await startBot({
    MANAGED_AGENT_TOKEN: "test-token",
    OPENAI_API_KEY: "",
    BOT_MODEL: "",
  });

  expect(exitCode).toBe(1);
  expect(stderr).toContain("OPENAI_API_KEY is not set");
}, 10_000);
