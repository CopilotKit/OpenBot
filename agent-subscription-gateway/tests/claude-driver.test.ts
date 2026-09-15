import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  DriverEvent,
  DriverRun,
  DriverRunContext,
} from "../src/drivers/agent-driver";
import {
  ClaudeDriver,
  type ClaudeChildProcess,
  type ClaudeProcessFactory,
  type ClaudeSpawnOptions,
} from "../src/drivers/claude/claude-driver";

const fixtures = join(import.meta.dir, "fixtures/claude-stream");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function processFor(output: string, exitCode = 0): ClaudeChildProcess {
  return {
    stdout: stream(output),
    stderr: stream("PRIVATE_STDERR\n"),
    exited: Promise.resolve(exitCode),
    kill() {},
  };
}

async function harness(
  fixture = "success.jsonl",
  loginExitCode = 0,
  environment: Record<string, string | undefined> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "openbot-claude-driver-"));
  directories.push(directory);
  const output = await readFile(join(fixtures, fixture), "utf8");
  const spawns: ClaudeSpawnOptions[] = [];
  const processFactory: ClaudeProcessFactory = (options) => {
    spawns.push(options);
    if (options.command.slice(1).join(" ") === "auth status") {
      return processFor(
        '{"loggedIn":true,"private":"DO_NOT_PARSE"}\n',
        loginExitCode,
      );
    }
    return processFor(output);
  };
  const driver = new ClaudeDriver({
    processFactory,
    binary: "/usr/local/bin/claude",
    environment,
  });
  return {
    driver,
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
  workspacePath: "/workspaces/claude/openbot-run-1",
};

const context = (signal = new AbortController().signal): DriverRunContext => ({
  signal,
});

async function collect(
  events: AsyncIterable<DriverEvent>,
): Promise<DriverEvent[]> {
  const result: DriverEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("ClaudeDriver", () => {
  test("runs the unmodified print CLI and maps text and native tool telemetry", async () => {
    const { driver, spawns, run } = await harness();

    const result = await collect(driver.start(run, context()));

    expect(spawns[0]).toMatchObject({ cwd: run.workspacePath });
    expect(spawns[0]?.command.slice(0, 2)).toEqual([
      "/usr/local/bin/claude",
      "-p",
    ]);
    expect(spawns[0]?.command).toEqual(
      expect.arrayContaining([
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "dontAsk",
      ]),
    );
    expect(spawns[0]?.command.join(" ")).not.toContain(
      "dangerously-skip-permissions",
    );
    expect(spawns[0]?.command.join(" ")).toContain("[system m1]");
    expect(result).toEqual([
      { type: "session", sessionId: "claude-session-new" },
      {
        type: "activity",
        message: "Bash started",
        data: { nativeTool: "Bash" },
      },
      { type: "text", delta: "Done" },
      { type: "text", delta: "." },
      { type: "activity", message: "Native tool completed" },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_COMMAND");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OUTPUT");
    expect(JSON.stringify(result)).not.toContain("TOOL_CALL");
  });

  test("resumes one stored session with only the supplied transcript delta", async () => {
    const { driver, spawns, run } = await harness();
    const resumed = {
      ...run,
      messages: [{ id: "m3", role: "user", content: "Fix the next test." }],
      sessionId: "claude-session-existing",
    };

    const result = await collect(driver.resume(resumed, context()));

    expect(spawns[0]?.command).toEqual(
      expect.arrayContaining(["--resume", "claude-session-existing"]),
    );
    expect(spawns[0]?.command.join(" ")).toContain("Fix the next test.");
    expect(spawns[0]?.command.join(" ")).not.toContain(
      "Run the focused tests.",
    );
    expect(result.some((event) => event.type === "session")).toBe(false);
  });

  test("reports rate-limit retry activity and hides provider error details", async () => {
    const { driver, run } = await harness("rate-limit.jsonl");
    const events: DriverEvent[] = [];

    try {
      for await (const event of driver.start(run, context()))
        events.push(event);
      throw new Error("Expected the Claude run to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("The Claude run failed.");
    }
    expect(events).toContainEqual({
      type: "activity",
      message: "Claude is retrying after a rate limit",
      data: { attempt: 2, maxRetries: 5 },
    });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_RATE_LIMIT_DETAILS");
  });

  test("fails closed when the CLI reports a permission denial", async () => {
    const { driver, run } = await harness("permission-denied.jsonl");

    await expect(collect(driver.start(run, context()))).rejects.toThrow(
      "The Claude run requested permission beyond worker policy.",
    );
  });

  test("passes only a small non-secret environment to Claude", async () => {
    const { driver, spawns, run } = await harness("success.jsonl", 0, {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/gateway",
      CLAUDE_CONFIG_DIR: "/home/gateway/.claude",
      LANG: "C.UTF-8",
      GATEWAY_TOKEN: "gateway-canary",
      ANTHROPIC_API_KEY: "api-canary",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-canary",
      AWS_SECRET_ACCESS_KEY: "aws-canary",
      SECRET_CANARY: "secret-canary",
    });

    await collect(driver.start(run, context()));

    expect(spawns[0]?.env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/gateway",
      CLAUDE_CONFIG_DIR: "/home/gateway/.claude",
      LANG: "C.UTF-8",
      CLAUDE_CODE_DISABLE_AUTO_UPDATER: "1",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    });
    expect(JSON.stringify(spawns[0]?.env)).not.toContain("canary");
  });

  test("checks auth through the CLI without credential-file access", async () => {
    const ready = await harness("success.jsonl", 0);
    const missing = await harness("success.jsonl", 1);

    expect(await ready.driver.isAuthReady()).toBe(true);
    expect(await missing.driver.isAuthReady()).toBe(false);
    expect(ready.spawns[0]?.command).toEqual([
      "/usr/local/bin/claude",
      "auth",
      "status",
    ]);
    const source = await readFile(
      join(import.meta.dir, "../src/drivers/claude/claude-driver.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/readFile|\.credentials\.json|\.claude\.json/);
  });

  test("cancellation escalates from interrupt to terminate and kill on a stuck CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-claude-cancel-"));
    directories.push(directory);
    const signals: number[] = [];
    let closeOutput: (() => void) | undefined;
    let resolveExit: ((code: number) => void) | undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '{"type":"system","subtype":"init","session_id":"claude-session-cancel"}\n',
          ),
        );
        closeOutput = () => controller.close();
      },
    });
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const processFactory: ClaudeProcessFactory = () => ({
      stdout,
      stderr: stream(""),
      exited,
      kill(signal) {
        signals.push(signal ?? 0);
        if (signal === constants.signals.SIGKILL) {
          closeOutput?.();
          resolveExit?.(137);
        }
      },
    });
    const driver = new ClaudeDriver({
      processFactory,
      interruptTimeoutMs: 5,
      terminateTimeoutMs: 5,
    });
    const controller = new AbortController();
    const iterator = driver
      .start({ ...run, workspacePath: directory }, context(controller.signal))
      [Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "session", sessionId: "claude-session-cancel" },
    });
    controller.abort();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(signals).toEqual([
      constants.signals.SIGINT,
      constants.signals.SIGTERM,
      constants.signals.SIGKILL,
    ]);
  });

  test("ships a pinned CLI and a fail-closed managed worker policy", async () => {
    const repository = join(import.meta.dir, "../..");
    const dockerfile = await readFile(
      join(repository, "agent-subscription-gateway/Dockerfile"),
      "utf8",
    );
    const compose = await readFile(
      join(repository, "deploy/aws/compose.worker.yml"),
      "utf8",
    );
    const settingsText = await readFile(
      join(repository, "deploy/aws/claude-managed-settings.json"),
      "utf8",
    );
    const settings = JSON.parse(settingsText) as {
      allowManagedHooksOnly: boolean;
      hooks: Record<string, unknown>;
      allowedHttpHookUrls: string[];
      allowManagedMcpServersOnly: boolean;
      allowedMcpServers: string[];
      allowManagedPermissionRulesOnly: boolean;
      permissions: {
        defaultMode: string;
        disableBypassPermissionsMode: string;
      };
      sandbox: {
        enabled: boolean;
        failIfUnavailable: boolean;
        allowUnsandboxedCommands: boolean;
        enableWeakerNestedSandbox: boolean;
        filesystem: { denyRead: string[]; allowManagedReadPathsOnly: boolean };
      };
    };

    expect(dockerfile).toContain("ARG CLAUDE_VERSION=2.1.271");
    expect(dockerfile).toMatch(
      /"@anthropic-ai\/claude-code@\$\{CLAUDE_VERSION\}"/,
    );
    expect(dockerfile).toMatch(/apt-get install[^\n]*bubblewrap[^\n]*socat/);
    expect(dockerfile).toContain("chmod 0755 /etc/codex /etc/claude-code");
    expect(dockerfile).toContain("/etc/claude-code/managed-settings.json");
    expect(compose).toContain('CLAUDE_VERSION: "2.1.271"');
    expect(compose).toContain("target: /etc/claude-code/managed-settings.json");
    expect(compose).toContain("read_only: true");

    expect(settings.allowManagedHooksOnly).toBe(true);
    expect(settings.hooks).toEqual({});
    expect(settings.allowedHttpHookUrls).toEqual([]);
    expect(settings.allowManagedMcpServersOnly).toBe(true);
    expect(settings.allowedMcpServers).toEqual([]);
    expect(settings.allowManagedPermissionRulesOnly).toBe(true);
    expect(settings.permissions.defaultMode).toBe("dontAsk");
    expect(settings.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      enableWeakerNestedSandbox: true,
    });
    expect(settings.sandbox.filesystem.denyRead).toEqual(
      expect.arrayContaining([
        "/home/gateway/.claude",
        "/var/lib/openbot-gateway",
      ]),
    );
    expect(settings.sandbox.filesystem.allowManagedReadPathsOnly).toBe(true);
  });
});
