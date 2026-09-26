import { expect, spyOn, test } from "bun:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createLearningSettingsStore } from "../src/learning/settings";
import { testEnvironment } from "./support/environment";

test("delegation creates its scratch Thread with the addressed Bot's Learning assignment before locking", async () => {
  const order: string[] = [];
  const reads = spyOn(
    CopilotKitIntelligence.prototype,
    "getThread",
  ).mockImplementation(async () => {
    order.push("check-thread");
    const error = new Error("Missing synthetic Thread");
    error.name = "PlatformRequestError";
    Object.assign(error, { status: 404 });
    throw error;
  });
  const created = spyOn(
    CopilotKitIntelligence.prototype,
    "getOrCreateThread",
  ).mockImplementation(async (input) => {
    order.push("create-thread");
    return { thread: { id: input.threadId, name: null }, created: true };
  });
  const locked = spyOn(
    CopilotKitIntelligence.prototype,
    "ɵacquireThreadLock",
  ).mockImplementation(async (input) => {
    order.push("lock");
    return {
      threadId: input.threadId,
      runId: input.runId,
      joinToken: "synthetic-join",
    };
  });
  const guard = createStallGuard({ stallMs: 0 });
  try {
    const settings = createLearningSettingsStore(undefined, {
      containerId: "general",
    });
    await settings.write({
      enabled: true,
      defaultTarget: { containerId: "general" },
      agents: { specialist: { containerId: "specialist-work" } },
    });
    const runtime = mountCopilotRuntime(
      loadConfig(testEnvironment()),
      { provider: "openai", defaultModel: "unused" },
      async () => [],
      async () => null,
      async () => ({ id: "person", name: "Person" }),
      async () => ({ id: "person", role: "user" }),
      guard,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      settings,
    );
    expect(
      await runtime.threadLock.acquire({
        threadId: "scratch",
        runId: "delegation-run",
        userId: "person",
        agentId: "specialist",
      }),
    ).toEqual({ runId: "delegation-run" });
    expect(order).toEqual(["check-thread", "create-thread", "lock"]);
    expect(reads.mock.calls[0]?.[0]).toEqual({
      threadId: "scratch",
      userId: "person",
    });
    expect(created.mock.calls[0]?.[0]).toMatchObject({
      threadId: "scratch",
      userId: "person",
      agentId: "specialist",
      learningContainerId: "specialist-work",
    });
    expect(locked.mock.calls[0]?.[0]).toMatchObject({
      threadId: "scratch",
      userId: "person",
      agentId: "specialist",
      learningContainerId: "specialist-work",
    });
  } finally {
    reads.mockRestore();
    created.mockRestore();
    locked.mockRestore();
    guard.stop();
  }
});
