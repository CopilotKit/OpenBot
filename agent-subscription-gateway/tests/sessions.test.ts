import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "../src/storage/run-store";
import { prepareProviderRun } from "../src/runs/session-input";
import type {
  AgentDriver,
  DriverRun,
  DriverRunContext,
  DriverResumeRun,
} from "../src/drivers/agent-driver";
import { createGatewayHandler } from "../src/server/app";
import { BoundedRunQueue, HostSemaphore } from "../src/runs/queue";
import { RunService } from "../src/runs/run-service";

const directories: string[] = [];

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "openbot-sessions-"));
  directories.push(directory);
  return new RunStore(join(directory, "gateway.sqlite"));
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

const messages = [
  { id: "m1", role: "user", content: "First", secret: "drop-me" },
  { id: "m2", role: "assistant", content: [{ type: "text", text: "Second" }] },
  { id: "m3", role: "user", content: "Third" },
];

describe("run and session storage", () => {
  test("reserves provider plus run ID once", async () => {
    const runs = await store();
    const first = runs.reserveRun({
      provider: "codex",
      runId: "run-1",
      threadId: "thread-1",
    });
    const duplicate = runs.reserveRun({
      provider: "codex",
      runId: "run-1",
      threadId: "thread-1",
    });
    const otherProvider = runs.reserveRun({
      provider: "claude",
      runId: "run-1",
      threadId: "thread-1",
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.run).toEqual(first.run);
    expect(otherProvider.created).toBe(true);
    expect(runs.listRuns()).toHaveLength(2);
    runs.close();
  });

  test("sends sanitized full history once, then only the message delta", async () => {
    const runs = await store();

    const initial = prepareProviderRun(runs, "codex", "thread-1", messages);
    expect(initial).toEqual({
      messages: [
        { id: "m1", role: "user", content: "First" },
        { id: "m2", role: "assistant", content: "Second" },
        { id: "m3", role: "user", content: "Third" },
      ],
      acknowledgedMessageId: "m3",
    });

    runs.saveSession({
      provider: "codex",
      threadId: "thread-1",
      sessionId: "provider-session-1",
      acknowledgedMessageId: "m2",
    });
    const resumed = prepareProviderRun(runs, "codex", "thread-1", [
      ...messages,
      { id: "m4", role: "user", content: "Fourth", providerToken: "drop" },
    ]);

    expect(resumed).toEqual({
      sessionId: "provider-session-1",
      messages: [
        { id: "m3", role: "user", content: "Third" },
        { id: "m4", role: "user", content: "Fourth" },
      ],
      acknowledgedMessageId: "m4",
    });
    expect(
      prepareProviderRun(runs, "codex", "thread-1", [
        { id: "replacement", role: "user", content: "New canonical history" },
      ]),
    ).toEqual({
      messages: [
        { id: "replacement", role: "user", content: "New canonical history" },
      ],
      acknowledgedMessageId: "replacement",
    });
    runs.close();
  });

  test("treats an unknown mapping as a new session and rejects an invalid acknowledgement", async () => {
    const runs = await store();
    expect(
      prepareProviderRun(runs, "grok", "unknown", messages),
    ).not.toHaveProperty("sessionId");
    expect(() =>
      runs.saveSession({
        provider: "grok",
        threadId: "thread-1",
        sessionId: "../unsafe",
        acknowledgedMessageId: "m1",
      }),
    ).toThrow(/session/i);
    expect(() =>
      prepareProviderRun(runs, "codex", "thread-1", [messages[0], messages[0]]),
    ).toThrow(/duplicate message/i);
    runs.close();
  });

  test("runs the HTTP chain once and resumes with only the new message", async () => {
    const runs = await store();
    const started: DriverRun[] = [];
    const resumed: DriverResumeRun[] = [];
    const driver: AgentDriver = {
      provider: "codex",
      version: "test",
      async isAuthReady() {
        return true;
      },
      async *start(run: DriverRun, _context: DriverRunContext) {
        started.push(run);
        yield { type: "session", sessionId: "native-session-1" };
        yield { type: "text", delta: "done" };
      },
      async *resume(run: DriverResumeRun, _context: DriverRunContext) {
        resumed.push(run);
        yield { type: "text", delta: "again" };
      },
      async cancel() {},
    };
    const workspace = {
      async create(runId: string) {
        return {
          provider: "codex",
          runId,
          path: `/fixed/jobs/codex/${runId}`,
          baseCommit: "a".repeat(40),
        };
      },
      async captureResult(lease: { baseCommit: string }) {
        return { patch: "patch", baseCommit: lease.baseCommit, commits: [] };
      },
    };
    const queue = new BoundedRunQueue({
      provider: "codex",
      host: new HostSemaphore(1),
    });
    const runService = new RunService({
      driver,
      store: runs,
      queue,
      workspaces: workspace,
      logger: { terminal() {} },
    });
    const handle = createGatewayHandler({
      token: "worker-secret",
      driver,
      runService,
    });
    const send = (runId: string, inputMessages: unknown[]) =>
      handle(
        new Request("http://gateway.test/ag-ui", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openbot-agent-token": "worker-secret",
          },
          body: JSON.stringify({
            threadId: "thread-http",
            runId,
            messages: inputMessages,
            tools: [],
          }),
        }),
      );

    const first = await send("http-1", messages.slice(0, 2));
    expect((await first.text()).match(/RUN_FINISHED/g)).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      workspacePath: "/fixed/jobs/codex/http-1",
      messages: [
        { id: "m1", role: "user", content: "First" },
        { id: "m2", role: "assistant", content: "Second" },
      ],
    });
    expect(runs.getRun("codex", "http-1")).toMatchObject({
      state: "completed",
      providerSessionId: "native-session-1",
      acknowledgedMessageId: "m2",
      patch: "patch",
    });

    const second = await send("http-2", messages);
    expect((await second.text()).match(/RUN_FINISHED/g)).toHaveLength(1);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      sessionId: "native-session-1",
      messages: [{ id: "m3", role: "user", content: "Third" }],
      workspacePath: "/fixed/jobs/codex/http-2",
    });

    const duplicate = await send("http-2", messages);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      retryable: false,
      run: { runId: "http-2", state: "completed", resultAvailable: true },
    });
    expect(resumed).toHaveLength(1);
    runs.close();
  });
});
