import { expect, test } from "bun:test";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createResponsibilityEngine } from "../src/responsibilities/engine";
import {
  parseResponsibilityInput,
  parseResponsibilityEvent,
  type ResponsibilityRunContext,
  type ResponsibilityRunOutcome,
} from "../src/responsibilities/types";
import type { WorkItem } from "../src/work/queue";

function runContext(): ResponsibilityRunContext {
  return {
    runId: "run-1",
    responsibilityId: "goal-1",
    ownerUserId: "person-1",
    agentId: "bot-1",
    channelId: "channel-1",
    threadId: "thread-1",
    instruction: "Produce the quarterly graph",
    successCriteria: "Graph is visible",
    progress: "",
    eventId: "event-1",
    event: { source: "github", type: "issue.opened", payload: { number: 8 } },
    continuation: null,
  };
}

function fixture(
  runTurn: (
    input: ResponsibilityRunContext & { signal: AbortSignal },
  ) => Promise<{ replyText: string }>,
) {
  const outcomes: ResponsibilityRunOutcome[] = [];
  const finished: string[] = [];
  const context = runContext();
  let available = true;
  const item: WorkItem = {
    kind: "responsibility.run",
    key: "run-1",
    payload: { runId: "run-1" },
    attempts: 1,
  };
  const engine = createResponsibilityEngine({
    store: {
      async ingestEvent() {
        return { eventId: "event-1", duplicate: false, runIds: ["run-1"] };
      },
      async beginRun() {
        if (!available) return null;
        available = false;
        return context;
      },
      async settleRun(_id, outcome) {
        outcomes.push(outcome);
      },
    },
    queue: {
      async claim() {
        return [item];
      },
      async renew() {
        return true;
      },
      async finish(input) {
        finished.push(input.key);
        return true;
      },
    },
    runTurn,
  });
  return { engine, outcomes, finished };
}

test("validates finite goals and authenticated normalized event shape", () => {
  expect(() =>
    parseResponsibilityInput({
      agentId: "bot",
      channelId: "channel",
      title: " ",
      instruction: "do",
      successCriteria: "done",
    }),
  ).toThrow();
  expect(() =>
    parseResponsibilityEvent({
      ownerUserId: "person",
      source: "github",
      externalId: "",
      type: "issue",
      payload: {},
    }),
  ).toThrow();
  expect(
    parseResponsibilityInput({
      agentId: "bot",
      channelId: "channel",
      title: "Quarterly graph",
      instruction: "Draw graph",
      successCriteria: "Graph is visible",
      subscriptions: [{ source: "github", eventType: "issue.opened" }],
    }).subscriptions,
  ).toHaveLength(1);
});

test("runs the selected owned Bot once and preserves its progress reply", async () => {
  const received: ResponsibilityRunContext[] = [];
  const { engine, outcomes, finished } = fixture(async (input) => {
    received.push(input);
    return { replyText: "The quarterly graph is ready." };
  });
  await engine.dispatch({ owner: "replica-1" });
  await engine.dispatch({ owner: "replica-2" });
  expect(received).toHaveLength(1);
  expect(received[0]?.agentId).toBe("bot-1");
  expect(outcomes).toEqual([
    { status: "succeeded", replyText: "The quarterly graph is ready." },
  ]);
  expect(finished).toEqual(["run-1", "run-1"]);
});

test("suspension persists the canonical waiting action and does not retry", async () => {
  let calls = 0;
  const waiting = {
    kind: "approval",
    requestId: "approval-1",
    toolCallId: "tool-1",
    args: { destination: "team" },
    runId: "canonical-run",
  };
  const { engine, outcomes } = fixture(async () => {
    calls += 1;
    throw new HeadlessToolSuspension("Approve this message", waiting);
  });
  const report = await engine.dispatch({ owner: "replica-1" });
  await engine.dispatch({ owner: "replica-2" });
  expect(calls).toBe(1);
  expect(report.waiting).toEqual(["run-1"]);
  expect(outcomes).toEqual([
    { status: "waiting", waiting, error: "Approve this message" },
  ]);
});

test("a failed selected-agent turn is recorded and never silently retried", async () => {
  let calls = 0;
  const { engine, outcomes } = fixture(async () => {
    calls += 1;
    throw new Error("Agent transport unavailable");
  });
  const report = await engine.dispatch({ owner: "replica-1" });
  await engine.dispatch({ owner: "replica-2" });
  expect(calls).toBe(1);
  expect(report.failed).toEqual([
    { runId: "run-1", error: "Agent transport unavailable" },
  ]);
  expect(outcomes).toEqual([
    { status: "failed", error: "Agent transport unavailable" },
  ]);
});
