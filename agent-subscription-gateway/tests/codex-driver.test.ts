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
  CodexDriver,
  type CodexProcessFactory,
  type CodexSpawnOptions,
} from "../src/drivers/codex/codex-driver";

const fixture = join(
  import.meta.dir,
  "fixtures/codex-app-server/fake-app-server.ts",
);
const bun = (() => {
  const path = Bun.which("bun");
  if (!path) throw new Error("Bun is required for the Codex fixture.");
  return path;
})();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function harness(
  scenario: "success" | "approval" | "cancel" | "failure" = "success",
  loginExitCode = 0,
) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-codex-driver-"));
  directories.push(directory);
  const capturePath = join(directory, "messages.jsonl");
  const spawns: CodexSpawnOptions[] = [];
  const processFactory: CodexProcessFactory = (options) => {
    spawns.push(options);
    if (options.command.slice(1).join(" ") === "login status") {
      return Bun.spawn([bun, "-e", `process.exit(${loginExitCode})`], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    return Bun.spawn([bun, fixture], {
      cwd: options.cwd,
      env: {
        ...options.env,
        FAKE_CODEX_SCENARIO: scenario,
        FAKE_CODEX_CAPTURE: capturePath,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  };
  const driver = new CodexDriver({
    processFactory,
    binary: "/usr/local/bin/codex",
    environment: {
      PATH: process.env.PATH,
      HOME: directory,
      CODEX_HOME: join(directory, ".codex"),
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
  workspacePath: "/workspaces/codex/openbot-run-1",
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

describe("CodexDriver", () => {
  test("uses the stable app-server handshake and streams safe text and activity", async () => {
    const { driver, captured, spawns, run } = await harness();

    const result = await collect(driver.start(run, context()));
    const messages = await captured();

    expect(spawns[0]).toMatchObject({
      command: ["/usr/local/bin/codex", "app-server"],
      cwd: run.workspacePath,
    });
    expect(spawns[0]?.env.GATEWAY_TOKEN).toBeUndefined();
    expect(spawns[0]?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(messages[2]).toMatchObject({
      method: "thread/start",
      params: {
        cwd: run.workspacePath,
        approvalPolicy: "never",
        permissions: "openbot-worker",
      },
    });
    expect(messages[3]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "codex-thread-new",
        cwd: run.workspacePath,
        approvalPolicy: "never",
      },
    });
    expect(JSON.stringify(messages[3])).toContain("[system m1]");
    expect(JSON.stringify(messages[3])).toContain("Run the focused tests.");
    expect(result).toEqual([
      { type: "session", sessionId: "codex-thread-new" },
      {
        type: "activity",
        message: "Command started",
        data: { itemType: "commandExecution", status: "inProgress" },
      },
      {
        type: "activity",
        message: "Command produced output",
        data: { itemType: "commandExecution" },
      },
      {
        type: "activity",
        message: "Command completed",
        data: { itemType: "commandExecution", status: "completed" },
      },
      { type: "text", delta: "Done." },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_COMMAND");
    expect(JSON.stringify(result)).not.toContain("/private/path");
  });

  test("resumes the mapped Codex thread and sends only the supplied transcript delta", async () => {
    const { driver, captured, run } = await harness();
    const resumed = {
      ...run,
      messages: [{ id: "m3", role: "user", content: "Now fix the next test." }],
      sessionId: "codex-thread-existing",
    };

    const result = await collect(driver.resume(resumed, context()));
    const messages = await captured();

    expect(messages[2]).toEqual({
      id: 2,
      method: "thread/resume",
      params: {
        approvalPolicy: "never",
        cwd: run.workspacePath,
        permissions: "openbot-worker",
        threadId: "codex-thread-existing",
      },
    });
    expect(JSON.stringify(messages[3])).toContain("Now fix the next test.");
    expect(JSON.stringify(messages[3])).not.toContain("Run the focused tests.");
    expect(result.some((event) => event.type === "session")).toBe(false);
  });

  test("fails closed when app-server asks the gateway for approval", async () => {
    const { driver, captured, run } = await harness("approval");

    await expect(collect(driver.start(run, context()))).rejects.toThrow(
      "The Codex run requested interactive input and was stopped.",
    );
    const messages = await captured();
    expect(messages).toContainEqual({
      id: 700,
      error: {
        code: -32000,
        message: "Interactive requests are disabled by worker policy.",
      },
    });
    expect(JSON.stringify(messages)).not.toContain("acceptForSession");
  });

  test("maps private provider failures to a fixed terminal message", async () => {
    const { driver, run } = await harness("failure");

    await expect(collect(driver.start(run, context()))).rejects.toThrow(
      "The Codex run failed.",
    );
  });

  test("cancels with turn/interrupt and stops the child process", async () => {
    const { driver, captured, run } = await harness("cancel");
    const iterator = driver.start(run, context())[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "session", sessionId: "codex-thread-new" },
    });
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "activity", message: "Command started" },
    });

    await driver.cancel(run.runId);
    await iterator.return?.();

    expect(await captured()).toContainEqual({
      id: 4,
      method: "turn/interrupt",
      params: { threadId: "codex-thread-new", turnId: "codex-turn-1" },
    });
  });

  test("checks login through the CLI without reading provider files", async () => {
    const ready = await harness("success", 0);
    const missing = await harness("success", 1);

    expect(await ready.driver.isAuthReady()).toBe(true);
    expect(await missing.driver.isAuthReady()).toBe(false);
    expect(ready.spawns[0]?.command).toEqual([
      "/usr/local/bin/codex",
      "login",
      "status",
    ]);
    expect(JSON.stringify(ready.spawns)).not.toContain("auth.json");
  });
});
