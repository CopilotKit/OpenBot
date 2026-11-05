import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  type CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import { createIntelligenceThreadLock } from "@openbot/toolkit/copilotkit/thread-lock";
import { createTurnRunner, type TurnRunner } from "@openbot/toolkit/run-turn";
import { Observable } from "rxjs";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import type { HandoffWork } from "../src/agents/handoff-runner";
import { createSubagents } from "../src/agents/subagent";
import { PERSON_INITIATOR } from "../src/audit";
import type { ChannelStore } from "../src/channels/routes";
import { createIntelligenceClient } from "../src/intelligence-client";
import { createRoutineRunner } from "../src/routines/runner";
import type { RoutineStore } from "../src/routines/store";
import { createTaskRunner, taskExecutionId } from "../src/tasks/runner";
import { createTaskTurn } from "../src/tasks/turn";
import { createProductTelemetry } from "../src/telemetry/product";
// A namespace, so a missing export fails the one test that needs it rather than the whole file.
import * as boundaries from "../src/telemetry/product-boundaries";
import type { WorkQueue } from "../src/work/queue";
import contract from "./fixtures/app-analytics-context-v1.json";

/**
 * What OpenBot tells Intelligence about a run, under CopilotKit's contract key.
 *
 * A browser run carries the context in `forwardedProps.__copilotkitAnalyticsContext`, which the
 * runtime takes off and sends on the thread lock. A headless turn, and a Bot-to-Bot hop, take the
 * lock themselves, so they send it there directly. Each case is built through the server's own
 * code: the request hook, the routine runner, a subagent, a task's retry, a hop. The Intelligence
 * platform is the only fake, on 127.0.0.1, and what the real client sends it is captured.
 *
 * `@copilotkit/runtime` 1.83.0 drops `analyticsContext` from the lock request; the release that
 * sends it is not out yet. So every case asserts what OpenBot handed the lock call, and the wire
 * body is asserted against what the installed runtime is measured to forward. When the dependency
 * moves, the wire assertions start requiring the context without a change here.
 */

const KEY = "synthetic-privacy-key";
const DEPLOYMENT = "dep_fixture_01";
const ACTOR = "user_person_one";
const ANALYTICS = "__copilotkitAnalyticsContext";

/** The existing `ob_` pseudonym, derived here independently of the code under test. */
const appUserHash = (actor: string) =>
  `ob_${createHmac("sha256", KEY).update(`openbot-product\0${DEPLOYMENT}\0${actor}`).digest("hex")}`;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/* ------------------------------------------------------------------------------------------------
 * The contract, version 1, as the Notion build page states it. Checked against the shared fixture
 * below before it is trusted with anything OpenBot produces.
 * --------------------------------------------------------------------------------------------- */

const FIELDS = [
  "app_context_version",
  "app_id",
  "deployment_id",
  "app_user_hash",
  "trigger",
  "surface",
  "environment",
  "purpose",
  "root_task_id",
  "parent_run_id",
  "attempt",
] as const;
const ENUMS: Record<string, readonly string[]> = {
  trigger: ["human", "routine", "followup", "subagent", "unknown"],
  surface: ["web", "desktop", "mobile", "external_channel", "unknown"],
  environment: ["production", "development", "test", "unknown"],
  purpose: ["ordinary", "setup", "unknown"],
};

/** Every rule a present field breaks, and any key outside the contract. */
function ruleProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return ["not an object"];
  const context = value as Record<string, unknown>;
  const problems = Object.keys(context)
    .filter((key) => !(FIELDS as readonly string[]).includes(key))
    .map((key) => `extra field ${key}`);
  const check = (field: string, ok: (v: unknown) => boolean) => {
    if (field in context && !ok(context[field])) problems.push(field);
  };
  const matches = (pattern: RegExp) => (v: unknown) =>
    typeof v === "string" && pattern.test(v);
  check("app_context_version", (v) => v === 1);
  check("app_id", matches(/^[a-z][a-z0-9_-]{0,63}$/));
  check(
    "deployment_id",
    (v) => v === "unknown" || matches(/^[A-Za-z0-9_:.-]{1,128}$/)(v),
  );
  check("app_user_hash", matches(/^ob_[0-9a-f]{64}$/));
  for (const [field, values] of Object.entries(ENUMS))
    check(field, (v) => typeof v === "string" && values.includes(v));
  check("root_task_id", (v) => v === null || matches(/^[0-9a-f]{64}$/)(v));
  check("parent_run_id", (v) => typeof v === "string" && v.length > 0);
  check(
    "attempt",
    (v) =>
      v === null ||
      (Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 10000),
  );
  return problems;
}

/** The rules, plus every field but the optional parent being present: what OpenBot must send. */
function contractProblems(value: unknown): string[] {
  const problems = ruleProblems(value);
  if (problems.includes("not an object")) return problems;
  const context = value as Record<string, unknown>;
  for (const field of FIELDS)
    if (field !== "parent_run_id" && !(field in context))
      problems.push(`missing ${field}`);
  return problems;
}

/* ------------------------------------------------------------------------------------------------
 * The Intelligence platform: REST and the runner's Phoenix channel, acknowledging what a healthy
 * platform acknowledges and writing down every request body.
 * --------------------------------------------------------------------------------------------- */

type Captured = { method: string; path: string; body: Record<string, unknown> };
const captured: Captured[] = [];
let platform: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  type Frame = [string | null, string | null, string, string, unknown];
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/runner/websocket")
        return server.upgrade(request, {
          data: undefined,
          headers: { "Sec-WebSocket-Protocol": "phoenix" },
        })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      const text = await request.text();
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      captured.push({ method: request.method, path: url.pathname, body });
      const [, api, threads, threadId, rest] = url.pathname.split("/");
      if (api !== "api" || threads !== "threads")
        return Response.json({ error: "not found" }, { status: 404 });
      if (!threadId && request.method === "POST")
        return Response.json({ thread: { id: body.threadId } });
      if (rest === undefined && request.method === "GET")
        return Response.json({ thread: { id: threadId } });
      if (rest === "messages") return Response.json({ messages: [] });
      if (rest === "lock" && request.method === "POST")
        return Response.json({
          threadId,
          runId: body.runId,
          joinToken: "join-token",
          ttlSeconds: 120,
        });
      if (rest === "lock" && request.method === "PATCH")
        return Response.json({ ttlSeconds: 120 });
      if (rest === "lock" && request.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const [joinRef, ref, topic] = JSON.parse(String(message)) as Frame;
        socket.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            "phx_reply",
            { status: "ok", response: {} },
          ]),
        );
      },
    },
  });
});

afterAll(() => {
  platform.stop(true);
});

/** The real client, with what OpenBot hands its lock call written down on the way through. */
function intelligence() {
  const client = createIntelligenceClient({
    apiUrl: `http://127.0.0.1:${platform.port}`,
    gatewayWsUrl: `ws://127.0.0.1:${platform.port}`,
    apiKey: "cpk-test-key",
  });
  const lockCalls: Record<string, unknown>[] = [];
  const recording = new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property !== "ɵacquireThreadLock" || typeof value !== "function")
        return value;
      return (params: Record<string, unknown>) => {
        lockCalls.push(params);
        return Reflect.apply(value, target, [params]);
      };
    },
  }) as CopilotKitIntelligence;
  return { client: recording, lockCalls };
}

/** The lock request body the platform received for a thread. */
function lockBody(threadId: string): Record<string, unknown> {
  const found = captured.filter(
    (request) =>
      request.method === "POST" &&
      request.path === `/api/threads/${encodeURIComponent(threadId)}/lock`,
  );
  expect(found).toHaveLength(1);
  return found[0]?.body ?? {};
}

/**
 * Whether the installed runtime puts `analyticsContext` on the wire, measured by asking its client
 * to lock a probe thread with one.
 */
async function runtimeForwardsAnalyticsContext(): Promise<boolean> {
  const { client } = intelligence();
  const params: Parameters<CopilotKitIntelligence["ɵacquireThreadLock"]>[0] =
    Object.assign(
      {
        threadId: "probe-thread",
        runId: "probe-run",
        userId: "u",
        agentId: "a",
      },
      { analyticsContext: { probe: true } },
    );
  await client.ɵacquireThreadLock(params);
  return "analyticsContext" in lockBody("probe-thread");
}
let forwards = false;
beforeAll(async () => {
  forwards = await runtimeForwardsAnalyticsContext();
});

/** A Bot that answers, and remembers the forwardedProps its run was given. */
class AnsweringAgent extends AbstractAgent {
  static seen: unknown[] = [];
  run(input: RunAgentInput): Observable<BaseEvent> {
    AnsweringAgent.seen.push(input.forwardedProps);
    return new Observable<BaseEvent>((subscriber) => {
      const ids = { threadId: input.threadId, runId: input.runId };
      subscriber.next({ type: EventType.RUN_STARTED, ...ids } as BaseEvent);
      for (const event of [
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "reply",
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "reply",
          delta: "Done.",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
        { type: EventType.RUN_FINISHED, ...ids },
      ])
        subscriber.next(event as BaseEvent);
      subscriber.complete();
    });
  }
}

async function telemetry(enabled = true) {
  return createProductTelemetry({
    privacyKey: KEY,
    deploymentId: DEPLOYMENT,
    env: enabled ? { OPENBOT_PRODUCT_TELEMETRY: "1", NODE_ENV: "test" } : {},
    send: async () => {},
  });
}
type Telemetry = Awaited<ReturnType<typeof telemetry>>;

/** The headless turn every routine, task, check-in and subagent runs through, as index.ts wires it. */
function turnOptions(product: Telemetry, client: CopilotKitIntelligence) {
  return {
    prepareRunInput: boundaries.productHeadlessBoundary(product),
    admission: async () => new AbortController().signal,
    intelligence: client,
    runner: new IntelligenceAgentRunner({
      url: client.ɵgetRunnerWsUrl(),
      authToken: client.ɵgetRunnerAuthToken(),
    }),
    heartbeatMs: 60_000,
  };
}
const buildAgentFor = async () => new AnsweringAgent({ agentId: "bot_helper" });

/** A browser run's request, through the hook copilot.ts installs before the runtime. */
async function browserRun(
  product: Telemetry,
  input: { threadId: string; runId: string; askId: string },
  forwardedProps: Record<string, unknown> = {},
) {
  const request = new Request(
    "http://127.0.0.1/api/copilotkit/agent/bot_helper/run",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: input.threadId,
        runId: input.runId,
        state: {},
        messages: [
          { id: input.askId, role: "user", content: "a private prompt" },
        ],
        tools: [],
        context: [],
        forwardedProps,
      }),
    },
  );
  const hook = boundaries.productRuntimeHook(product, async () => ({
    id: ACTOR,
    role: "user",
  }));
  const rewritten = await hook({
    request,
    route: { method: "agent/run", agentId: "bot_helper" },
  } as Parameters<typeof hook>[0]);
  expect(rewritten).toBeInstanceOf(Request);
  const body = (await (rewritten as Request).json()) as {
    forwardedProps: Record<string, unknown>;
  };
  return body.forwardedProps;
}

/** The analytics context the platform received on a thread's lock, or null. */
function onTheWire(threadId: string) {
  return lockBody(threadId).analyticsContext ?? null;
}

describe("the shared contract", () => {
  test("the validator accepts every valid fixture and refuses every invalid one by a rule", () => {
    for (const { name, context } of contract.valid)
      expect({ name, problems: contractProblems(context) }).toEqual({
        name,
        problems: [],
      });
    for (const { name, context } of contract.invalid)
      expect({ name, broken: ruleProblems(context).length > 0 }).toEqual({
        name,
        broken: true,
      });
  });
});

describe("a run tells Intelligence its context, under the contract key", () => {
  test("a person's run in the web app carries it in forwardedProps, replacing what the browser sent", async () => {
    const product = await telemetry();
    const forwardedProps = await browserRun(
      product,
      { threadId: "thread-web", runId: "run-web", askId: "ask-web" },
      {
        custom: "kept",
        [ANALYTICS]: { app_context_version: 1, app_id: "forged" },
      },
    );
    const hash = appUserHash(ACTOR);
    expect(forwardedProps[ANALYTICS]).toEqual({
      app_context_version: 1,
      app_id: "openbot",
      deployment_id: DEPLOYMENT,
      app_user_hash: hash,
      trigger: "human",
      surface: "web",
      environment: "test",
      purpose: "ordinary",
      root_task_id: sha256(`${hash}:thread-web:ask-web`),
      attempt: null,
    });
    expect(contractProblems(forwardedProps[ANALYTICS])).toEqual([]);
    expect(forwardedProps.custom).toBe("kept");
    // No raw identifier, name, prompt or URL of the person or the run.
    const sent = JSON.stringify(forwardedProps[ANALYTICS]);
    for (const raw of [ACTOR, "thread-web", "run-web", "ask-web", "private"])
      expect(sent).not.toContain(raw);
  });

  test("a routine's firing sends it on the headless lock, and the Bot never sees it", async () => {
    const product = await telemetry();
    const { client, lockCalls } = intelligence();
    const finished: string[] = [];
    const routineStore = {
      runContext: async () => ({
        routineId: "routine_standup",
        ownerUserId: ACTOR,
        agentId: "bot_helper",
        channelId: "channel_standup",
        instruction: "Post the standup summary.",
      }),
      finishRun: async (_id: string, status: string) => {
        finished.push(status);
      },
      consecutiveFailures: async () => 0,
    } as unknown as RoutineStore;
    const channelStore = {
      get: async () => ({
        id: "channel_standup",
        name: "Standup",
        agentIds: ["bot_helper"],
        threadId: "thread-routine",
        active: true,
      }),
      recordActivity: async () => {},
      signalBusy: async () => {},
    } as unknown as ChannelStore;
    AnsweringAgent.seen = [];
    await createRoutineRunner({
      routineStore,
      channelStore,
      runTurn: createTurnRunner({
        ...turnOptions(product, client),
        buildAgentFor,
      }),
    }).run("routine_run_7");
    expect(finished).toEqual(["succeeded"]);

    const hash = appUserHash(ACTOR);
    const expected = {
      app_context_version: 1,
      app_id: "openbot",
      deployment_id: DEPLOYMENT,
      app_user_hash: hash,
      trigger: "routine",
      surface: "unknown",
      environment: "test",
      purpose: "ordinary",
      root_task_id: sha256(`${hash}:routine_run_7`),
      attempt: null,
    };
    expect(lockCalls.map((call) => call.analyticsContext)).toEqual([expected]);
    expect(contractProblems(expected)).toEqual([]);
    expect(onTheWire("thread-routine")).toEqual(forwards ? expected : null);
    // Taken off the run's input, as the runtime does for a browser run; OpenBot's own copy stays.
    expect(AnsweringAgent.seen).toHaveLength(1);
    const props = AnsweringAgent.seen[0] as Record<string, unknown>;
    expect(ANALYTICS in props).toBe(false);
    expect(props.openbotTelemetry).toMatchObject({ trigger: "routine" });
  });

  test("a subagent sends it with its parent run, and its parent's root task and surface", async () => {
    const product = await telemetry();
    const { client, lockCalls } = intelligence();
    // A person's run in the web app, and one from the native app, each starting a subagent.
    const web = await browserRun(product, {
      threadId: "thread-parent",
      runId: "run-parent",
      askId: "ask-parent",
    });
    const mobile = (
      await boundaries.productHeadlessBoundary(product)(
        {
          threadId: "thread-mobile",
          runId: "inbox-mobile",
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        {
          ownerUserId: ACTOR,
          routineId: "delivery:inbox-mobile",
          agentId: "bot_helper",
          threadId: "thread-mobile",
          instruction: "What is on my calendar?",
          telemetry: boundaries.deliveryLineage("native", "inbox-mobile"),
        },
      )
    ).forwardedProps as Record<string, unknown>;
    const parents = [
      { threadId: "thread-parent", runId: "run-parent", props: web },
      { threadId: "thread-mobile", runId: "inbox-mobile", props: mobile },
    ];
    const subagents = createSubagents({
      turn: turnOptions(product, client),
      buildAgentFor,
      withdrawApprovals: async () => undefined,
    });
    const threads: string[] = [];
    for (const parent of parents) {
      // As index.ts offers the tool to a run: the run's own input names its task and surface.
      const tool = subagents.toolForRun({
        actorId: ACTOR,
        botId: "bot_helper",
        threadId: parent.threadId,
        runId: parent.runId,
        ...product.lineageOf(ACTOR, parent.props),
        initiator: PERSON_INITIATOR,
      });
      const answer = JSON.parse(
        String(
          await tool.execute?.(
            { task: "Count the open tickets.", answer: "A number." },
            { toolCallId: `call-${parent.runId}` } as never,
          ),
        ),
      ) as { answer?: string; threadId: string };
      expect(answer.answer).toBe("Done.");
      threads.push(answer.threadId);
    }

    const expected = parents.map((parent) => ({
      app_context_version: 1,
      app_id: "openbot",
      deployment_id: DEPLOYMENT,
      app_user_hash: appUserHash(ACTOR),
      trigger: "subagent",
      surface: parent.props === web ? "web" : "mobile",
      environment: "test",
      purpose: "ordinary",
      root_task_id: (parent.props[ANALYTICS] as Record<string, unknown>)
        .root_task_id,
      parent_run_id: parent.runId,
      attempt: null,
    }));
    expect(lockCalls.map((call) => call.analyticsContext)).toEqual(expected);
    for (const context of expected)
      expect(contractProblems(context)).toEqual([]);
    expect(threads.map(onTheWire)).toEqual(forwards ? expected : [null, null]);
  });

  test("a task's retry shares its first run's root task, as attempt 2", async () => {
    const product = await telemetry();
    const { client, lockCalls } = intelligence();
    const scope = {
      ownerUserId: ACTOR,
      channelId: "channel-task",
      agentId: "bot_helper",
      threadId: "thread-task",
    };
    // One queued turn, claimed for its first run and then for its retry.
    const claims = [1, 2].map((attempts) => ({
      kind: "proactive.task",
      key: "item-1",
      payload: {
        ownerUserId: ACTOR,
        taskId: "task-1",
        text: "Reply.",
        runs: 2,
      },
      attempts,
    }));
    const tasks = createTaskRunner({
      database: {} as never,
      store: {
        locate: async () => ({
          id: "task-1",
          channelId: scope.channelId,
          agentId: scope.agentId,
          title: "Reply to the vendor",
        }),
      } as never,
      channels: {} as never,
      actorFor: async (id) => ({ id, role: "user" }),
      queue: {
        claim: async () => claims.splice(0, 1),
        renew: async () => true,
        finish: async () => true,
        release: async () => true,
      } as unknown as WorkQueue,
      owner: "tasks",
      scopeFor: async () => scope,
      runTask: createTaskTurn({
        channels: {
          recordActivity: async () => {},
          signalBusy: async () => {},
        } as unknown as ChannelStore,
        actorFor: async (id) => ({ id, role: "user" }),
        runTurn: createTurnRunner({
          ...turnOptions(product, client),
          buildAgentFor,
        }),
      }),
      retryMs: 0,
    });
    await tasks.sweep();
    await tasks.sweep();
    await tasks.idle();

    const hash = appUserHash(ACTOR);
    // The ask is drawn under the first run's id, which is what the retry carries on.
    const ask = taskExecutionId({
      taskId: "task-1",
      workKey: "item-1",
      attempt: 1,
    });
    const sent = (attempt: number) => ({
      app_context_version: 1,
      app_id: "openbot",
      deployment_id: DEPLOYMENT,
      app_user_hash: hash,
      trigger: "human",
      surface: "web",
      environment: "test",
      purpose: "ordinary",
      root_task_id: sha256(`${hash}:${ask}`),
      attempt,
    });
    expect(lockCalls.map((call) => call.analyticsContext)).toEqual([
      sent(1),
      sent(2),
    ]);
    for (const attempt of [1, 2])
      expect(contractProblems(sent(attempt))).toEqual([]);
  });

  test("a message from the native app or a chat platform is a person's, on that surface", async () => {
    const product = await telemetry();
    const { client, lockCalls } = intelligence();
    const runTurn = createTurnRunner({
      ...turnOptions(product, client),
      buildAgentFor,
    });
    const hash = appUserHash(ACTOR);
    const sources = ["native", "slack", "teams", "sms"] as const;
    for (const source of sources)
      await runTurn({
        ownerUserId: ACTOR,
        routineId: `delivery:inbox-${source}`,
        runId: `inbox-${source}`,
        agentId: "bot_helper",
        threadId: `thread-${source}`,
        instruction: "What is on my calendar?",
        initiator: PERSON_INITIATOR,
        // As index.ts hands delivery's turns to the runner.
        telemetry: boundaries.deliveryLineage(source, `inbox-${source}`),
      });
    const expected = sources.map((source) => ({
      app_context_version: 1,
      app_id: "openbot",
      deployment_id: DEPLOYMENT,
      app_user_hash: hash,
      trigger: "human",
      surface: source === "native" ? "mobile" : "external_channel",
      environment: "test",
      purpose: "ordinary",
      root_task_id: sha256(`${hash}:inbox-${source}`),
      attempt: null,
    }));
    expect(lockCalls.map((call) => call.analyticsContext)).toEqual(expected);
    for (const context of expected)
      expect(contractProblems(context)).toEqual([]);
  });

  test("a Bot-to-Bot hop sends it on its own thread lock, and its run input does not carry it", async () => {
    const product = await telemetry();
    const { client, lockCalls } = intelligence();
    const work: HandoffWork = {
      fromBotId: "assistant",
      toBotId: "researcher",
      actorId: ACTOR,
      threadId: "thread-asking",
      runId: "run-asking",
      depth: 1,
      task: "find the outage window",
    };
    const inputs: Record<string, unknown>[] = [];
    const agent = {
      threadId: "",
      messages: [] as unknown[],
      setMessages(messages: unknown[]) {
        agent.messages = messages;
      },
    };
    await createHandoffDelivery({
      admission: async () => new AbortController().signal,
      prepareRunInput: (input) =>
        boundaries.productHandoffInput(
          product,
          input,
          work.actorId,
          work.runId,
        ),
      analyticsContextFor: (run) =>
        boundaries.productHandoffAnalyticsContext(
          product,
          run,
          work.actorId,
          work.runId,
        ),
      agentFor: async () => agent as unknown as AbstractAgent,
      history: async () => [],
      newRunId: () => "run-hop",
      mintThreadId: () => "thread-hop",
      lock: createIntelligenceThreadLock({ client }),
      runner: {
        run: (request) => {
          inputs.push(request.input as Record<string, unknown>);
          return new Observable<BaseEvent>((subscriber) => {
            subscriber.next({ type: EventType.RUN_FINISHED } as BaseEvent);
            subscriber.complete();
          });
        },
      },
    }).deliver({ work, message: "m", shown: "s", assertion: "signed" });

    const expected = {
      app_context_version: 1,
      app_id: "openbot",
      deployment_id: DEPLOYMENT,
      app_user_hash: appUserHash(ACTOR),
      trigger: "subagent",
      surface: "unknown",
      environment: "test",
      purpose: "ordinary",
      root_task_id: null,
      parent_run_id: "run-asking",
      attempt: null,
    };
    expect(lockCalls.map((call) => call.analyticsContext)).toEqual([expected]);
    expect(contractProblems(expected)).toEqual([]);
    expect(onTheWire("thread-hop")).toEqual(forwards ? expected : null);
    expect(inputs).toHaveLength(1);
    const props = inputs[0]?.forwardedProps as Record<string, unknown>;
    expect(ANALYTICS in props).toBe(false);
    expect(props.openbotRun).toBe("signed");
  });
});

describe("with product telemetry off, no context is sent", () => {
  test("a browser run's own claim is removed rather than passed to the runtime", async () => {
    const forwardedProps = await browserRun(
      await telemetry(false),
      { threadId: "thread-off", runId: "run-off", askId: "ask-off" },
      { custom: "kept", [ANALYTICS]: { app_context_version: 1 } },
    );
    expect(forwardedProps).toEqual({ custom: "kept" });
  });

  test("a headless turn locks without one", async () => {
    const { client, lockCalls } = intelligence();
    const runTurn: TurnRunner = createTurnRunner({
      ...turnOptions(await telemetry(false), client),
      buildAgentFor,
    });
    await runTurn({
      ownerUserId: ACTOR,
      routineId: "routine_off",
      agentId: "bot_helper",
      threadId: "thread-headless-off",
      instruction: "Post the standup summary.",
      telemetry: { trigger: "routine", rootTaskId: "routine_run_off" },
    });
    expect(lockCalls.map((call) => "analyticsContext" in call)).toEqual([
      false,
    ]);
    expect("analyticsContext" in lockBody("thread-headless-off")).toBe(false);
  });

  test("a context left in a resumed run's input is neither sent nor handed to the Bot", async () => {
    const { client, lockCalls } = intelligence();
    AnsweringAgent.seen = [];
    const runTurn: TurnRunner = createTurnRunner({
      ...turnOptions(await telemetry(), client),
      // The host could not state a context for this turn.
      prepareRunInput: async () => {
        throw new Error("unavailable");
      },
      buildAgentFor,
    });
    await runTurn({
      ownerUserId: ACTOR,
      routineId: "approval-resume",
      agentId: "bot_helper",
      threadId: "thread-resumed",
      instruction: "",
      continuation: {
        snapshot: {
          runId: "run-interrupted",
          threadId: "thread-resumed",
          toolCallId: "call-held",
          toolName: "send_email",
          args: {},
          messages: [],
          state: {},
          context: [],
          forwardedProps: { [ANALYTICS]: { app_context_version: 1 } },
        },
        result: { content: "Allowed." },
        messageId: "resume-message",
      },
    });
    expect(lockCalls.map((call) => "analyticsContext" in call)).toEqual([
      false,
    ]);
    expect(AnsweringAgent.seen).toHaveLength(1);
    expect(
      ANALYTICS in (AnsweringAgent.seen[0] as Record<string, unknown>),
    ).toBe(false);
  });
});
