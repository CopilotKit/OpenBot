import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { and, eq, inArray } from "drizzle-orm";
import { EMPTY } from "rxjs";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { responsibilityRuns } from "../src/db/schema/responsibilities";
import { workItems } from "../src/db/schema/work";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createServerResponsibilityEngine } from "../src/responsibilities/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A goal's run started while another run has its conversation.
 *
 * FOUND LIVE: "Create a goal … then run it now" in one message started the goal's run while the
 * Bot was still answering in that conversation. Intelligence refused the run's lock with 409
 * `THREAD_LOCK_FAILED`, marked retryable, and the run was recorded as failed with the platform's
 * response body as its reason.
 *
 * Real: PostgreSQL, the goal store and the work queue, the engine the server builds
 * (`createServerResponsibilityEngine`) and the headless turn it runs. Intelligence and the agent
 * runner are stand-ins; the refusal is the one Intelligence sent on that run, as the runtime's
 * client raises it.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `goal-run-busy-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const threadId = `${prefix}-thread`;

const store = createResponsibilityStore(database, {
  async resolveTarget(owner, bot, channel) {
    return owner === ownerId && bot === botId && channel === channelId
      ? { threadId }
      : null;
  },
});

/** The runtime's `PlatformRequestError`, which `@copilotkit/runtime` does not export. */
class PlatformRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable?: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PlatformRequestError";
  }
}

/** Intelligence's answer to the run's lock while the Bot was still answering, word for word. */
function lockRefused(retryable = true) {
  const body = JSON.stringify({
    error: {
      code: "THREAD_LOCK_FAILED",
      message: "Thread is already locked by another runner.",
      category: "conflict",
      retryable,
    },
    requestId: "9f62408a-71cc-49fb-9f43-0160cc8394db",
    traceId: "d7c2a4c678fd63c8b497a237fbe82c6f",
  });
  return new PlatformRequestError(
    `Intelligence platform error 409: ${body}`,
    409,
    retryable,
  );
}

class Agent extends AbstractAgent {
  run() {
    return EMPTY;
  }
}

/** Refuse the lock this many times, then hand it over. */
let busyFor = 0;
let retryable = true;
const acquired: string[] = [];
const replies: string[] = [];

const intelligence = {
  getOrCreateThread: async () => ({}),
  getThreadMessages: async () => ({ messages: [] }),
  ɵacquireThreadLock: async (input: { runId: string; threadId: string }) => {
    if (busyFor > 0) {
      busyFor -= 1;
      throw lockRefused(retryable);
    }
    acquired.push(input.runId);
    return { ...input, joinToken: "token" };
  },
  ɵrenewThreadLock: async () => ({ ttlSeconds: 120 }),
  ɵcleanupThreadLock: async () => undefined,
};

const engine = createServerResponsibilityEngine({
  database,
  responsibilityStore: store,
  routineIntelligence: intelligence as never,
  routineAgentRunner: {
    run: (request: { agent: AbstractAgent; input: RunAgentInput }) => ({
      subscribe(observer: { complete(): void }) {
        request.agent.setMessages([
          ...request.agent.messages,
          {
            id: `reply-${request.input.runId}`,
            role: "assistant",
            content: "Checked the releases.",
          },
        ]);
        observer.complete();
        return { unsubscribe() {} };
      },
    }),
    stop: async () => true,
  } as never,
  componentCatalog: { names: new Set(), toolsForTurn: async () => [] },
  buildAgentFor: async () => new Agent({ agentId: botId }),
  actorFor: async (id) => ({ id, role: "user" }),
  computerGateway: undefined,
  agentProfileStore: {} as never,
  bootAuditStore: {} as never,
  signInService: undefined,
  copilotRuntime: { learning: undefined } as never,
  channelStore: { recordActivity: async () => undefined } as never,
  notify: async (_scope, input) => {
    replies.push(input.text);
  },
  // The real waits double from five seconds; these are a millisecond, three tries.
  busyRetry: { firstMs: 1, maxMs: 1, tries: 3 },
});

const runIds: string[] = [];

/** Start a run of a new goal, as Run now does. */
async function runNow() {
  const goal = await store.create(ownerId, {
    agentId: botId,
    channelId,
    title: "Watch OpenBot releases",
    instruction: "Check the releases page.",
    successCriteria: "Each new release is reported.",
  });
  const { runIds: [runId] = [] } = await engine.ingest({
    ownerUserId: ownerId,
    responsibilityId: goal.id,
    source: "manual",
    externalId: randomUUID(),
    type: "requested",
    payload: {},
  });
  if (!runId) throw new Error("Expected a queued run.");
  runIds.push(runId);
  return runId;
}

async function runOf(runId: string) {
  const [run] = await database
    .select()
    .from(responsibilityRuns)
    .where(eq(responsibilityRuns.id, runId));
  if (!run) throw new Error("The run is gone.");
  return run;
}

/** One sweep of the goal engine, as the server's goal sweep runs it, after any wait has passed. */
async function sweep() {
  await Bun.sleep(5);
  return engine.dispatch({ owner: `${prefix}-sweep`, limit: 50 });
}

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: ownerId, email: `${ownerId}@example.test` });
  await database.insert(agents).values({
    id: botId,
    name: "Goal run busy test Bot",
    type: "built_in",
    configuration: {},
  });
});

beforeEach(() => {
  busyFor = 0;
  retryable = true;
  acquired.length = 0;
  replies.length = 0;
});

afterAll(async () => {
  if (runIds.length)
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "responsibility.run"),
          inArray(workItems.key, runIds),
        ),
      );
  await database.delete(users).where(eq(users.id, ownerId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.end({ timeout: 5 });
});

test("a run refused because its conversation is busy waits, then runs once it is free", async () => {
  busyFor = 2;
  const runId = await runNow();

  const first = await sweep();
  expect(first.busy).toContain(runId);
  expect(first.failed.map((failure) => failure.runId)).not.toContain(runId);
  // Back in the queue, not failed: nothing ran.
  expect((await runOf(runId)).status).toBe("queued");

  expect((await sweep()).busy).toContain(runId);
  const third = await sweep();
  expect(third.succeeded).toContain(runId);

  const run = await runOf(runId);
  expect(run.status).toBe("succeeded");
  expect(run.error).toBeNull();
  expect(run.replyText).toBe("Checked the releases.");
  expect(acquired).toHaveLength(1);
  expect(replies).toEqual(["Checked the releases."]);
});

test("a conversation that stays busy past the waits fails the run in words a person reads", async () => {
  busyFor = Number.POSITIVE_INFINITY;
  const runId = await runNow();

  for (let sweepCount = 0; sweepCount < 3; sweepCount += 1)
    expect((await sweep()).busy).toContain(runId);
  const last = await sweep();
  expect(last.failed.map((failure) => failure.runId)).toContain(runId);

  const run = await runOf(runId);
  expect(run.status).toBe("failed");
  expect(run.error).toBe(
    "This goal's conversation was busy for about a minute, so the run never started and nothing was done. Run the goal again when the conversation is free.",
  );
  expect(run.error).not.toContain("Intelligence platform error");
  expect(acquired).toEqual([]);
});

test("a refusal the platform marks as not retryable is not waited out", async () => {
  busyFor = 1;
  retryable = false;
  const runId = await runNow();

  const report = await sweep();
  expect(report.busy).not.toContain(runId);
  expect(report.failed.map((failure) => failure.runId)).toContain(runId);
  expect((await runOf(runId)).status).toBe("failed");
});
