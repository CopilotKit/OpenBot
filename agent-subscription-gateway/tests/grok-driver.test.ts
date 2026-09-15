import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  DriverEvent,
  DriverRun,
  DriverRunContext,
} from "../src/drivers/agent-driver";
import {
  GrokDriver,
  type GrokProcessFactory,
  type GrokSpawnOptions,
} from "../src/drivers/grok/grok-driver";

const fixture = join(import.meta.dir, "fixtures/grok-acp/fake-agent.ts");
const repositoryRoot = join(import.meta.dir, "..", "..");
const bun = (() => {
  const path = Bun.which("bun");
  if (!path) throw new Error("Bun is required for the Grok fixture.");
  return path;
})();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function harness(
  scenario: "success" | "permission" | "cancel" | "failure" = "success",
  authExitCode = 0,
) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-grok-driver-"));
  directories.push(directory);
  const capturePath = join(directory, "messages.jsonl");
  const spawns: GrokSpawnOptions[] = [];
  const processFactory: GrokProcessFactory = (options) => {
    spawns.push(options);
    if (options.command.slice(1).join(" ") === "models") {
      return Bun.spawn([bun, "-e", `process.exit(${authExitCode})`], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    return Bun.spawn([bun, fixture], {
      cwd: options.cwd,
      env: {
        ...options.env,
        FAKE_GROK_SCENARIO: scenario,
        FAKE_GROK_CAPTURE: capturePath,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  };
  const driver = new GrokDriver({
    processFactory,
    binary: "/usr/local/bin/grok",
    environment: {
      PATH: process.env.PATH,
      HOME: directory,
      GROK_HOME: join(directory, ".grok"),
      GATEWAY_TOKEN: "must-not-reach-provider",
      AWS_SECRET_ACCESS_KEY: "must-not-reach-provider",
    },
  });
  const captured = async () =>
    (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    driver,
    captured,
    spawns,
    run: { ...run, workspacePath: directory } satisfies DriverRun,
  };
}

const run: DriverRun = {
  threadId: "openbot-thread-1",
  runId: "openbot-run-1",
  messages: [
    { id: "m1", role: "system", content: "Use the repository rules." },
    { id: "m2", role: "user", content: "Run the focused tests." },
  ],
  context: [],
  state: {},
  forwardedProps: {},
  workspacePath: "/workspaces/grok/openbot-run-1",
};

const context = (): DriverRunContext => ({
  signal: new AbortController().signal,
});

async function collect(
  events: AsyncIterable<DriverEvent>,
): Promise<DriverEvent[]> {
  const result: DriverEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("GrokDriver", () => {
  test("uses ACP with the strict sandbox and streams only safe events", async () => {
    const { driver, captured, spawns, run } = await harness();

    const result = await collect(driver.start(run, context()));
    const messages = await captured();

    expect(spawns[0]).toMatchObject({
      command: [
        "/usr/local/bin/grok",
        "--no-subagents",
        "--sandbox",
        "strict",
        "agent",
        "--always-approve",
        "--no-leader",
        "stdio",
      ],
      cwd: run.workspacePath,
    });
    expect(spawns[0]?.env.GATEWAY_TOKEN).toBeUndefined();
    expect(spawns[0]?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    expect(messages[1]).toMatchObject({
      method: "session/new",
      params: {
        cwd: run.workspacePath,
        mcpServers: [],
        _meta: { yoloMode: true },
      },
    });
    expect(JSON.stringify(messages[2])).toContain("[system m1]");
    expect(result).toEqual([
      { type: "session", sessionId: "grok-session-new" },
      { type: "activity", message: "Native tool started" },
      {
        type: "activity",
        message: "Native tool completed",
        data: { status: "completed" },
      },
      { type: "text", delta: "Done." },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_COMMAND");
    expect(JSON.stringify(result)).not.toContain("/private/path");
  });

  test("loads the mapped ACP session and sends only the transcript delta", async () => {
    const { driver, captured, run } = await harness();
    const resumed = {
      ...run,
      messages: [{ id: "m3", role: "user", content: "Now fix the next test." }],
      sessionId: "grok-session-existing",
    };

    const result = await collect(driver.resume(resumed, context()));
    const messages = await captured();

    expect(messages[1]).toMatchObject({
      method: "session/load",
      params: {
        sessionId: "grok-session-existing",
        cwd: run.workspacePath,
        mcpServers: [],
      },
    });
    expect(JSON.stringify(messages[2])).toContain("Now fix the next test.");
    expect(JSON.stringify(messages[2])).not.toContain("Run the focused tests.");
    expect(result.some((event) => event.type === "session")).toBe(false);
  });

  test("fails closed when ACP asks the gateway for permission", async () => {
    const { driver, captured, run } = await harness("permission");

    await expect(collect(driver.start(run, context()))).rejects.toThrow(
      "The Grok run requested permission beyond worker policy.",
    );
    expect(await captured()).toContainEqual({
      jsonrpc: "2.0",
      id: 700,
      error: {
        code: -32000,
        message: "Interactive requests are disabled by worker policy.",
      },
    });
  });

  test("maps provider request failures to a fixed message", async () => {
    const { driver, run } = await harness("failure");
    await expect(collect(driver.start(run, context()))).rejects.toThrow(
      "The Grok agent rejected a request.",
    );
  });

  test("cancels the active ACP session", async () => {
    const { driver, captured, run } = await harness("cancel");
    const iterator = driver.start(run, context())[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "session", sessionId: "grok-session-new" },
    });
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "activity", message: "Native tool started" },
    });

    await driver.cancel(run.runId);
    await iterator.return?.();

    expect(await captured()).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "grok-session-new" },
    });
  });

  test("checks auth without reading or printing provider files", async () => {
    const ready = await harness("success", 0);
    const missing = await harness("success", 1);

    expect(await ready.driver.isAuthReady()).toBe(true);
    expect(await missing.driver.isAuthReady()).toBe(false);
    expect(ready.spawns.at(-1)?.command).toEqual([
      "/usr/local/bin/grok",
      "models",
    ]);
  });

  test("ships a pinned CLI and a fail-closed worker policy", async () => {
    const [dockerfile, requirements] = await Promise.all([
      readFile(
        join(repositoryRoot, "agent-subscription-gateway", "Dockerfile"),
        "utf8",
      ),
      readFile(
        join(repositoryRoot, "deploy", "aws", "grok-requirements.toml"),
        "utf8",
      ),
    ]);

    expect(dockerfile).toContain("ARG GROK_VERSION=1.0.30");
    expect(dockerfile).toMatch(/"@xai-official\/grok@\$\{GROK_VERSION\}"/);
    expect(dockerfile).toContain("/etc/grok/requirements.toml");
    expect(requirements).toContain("fail_closed = true");
    expect(requirements).toContain('profile = "strict"');
    expect(requirements).toContain('"Read(/home/gateway/.grok/**)"');
    expect(requirements).toContain("enabled = false");
    expect(requirements).toContain("trace_upload = false");
  });
});
