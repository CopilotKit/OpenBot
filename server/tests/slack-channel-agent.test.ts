import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  EMPTY,
  lastValueFrom,
  NEVER,
  type Observable,
  of,
  throwError,
} from "rxjs";
import { toArray } from "rxjs/operators";
import { z } from "zod";
import type { ActorAgentResolver } from "../src/agents/agent-resolver";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import type {
  ExternalThreadBinding,
  ExternalThreadStore,
} from "../src/external/thread-store";
import type { CoworkerRoutingService } from "../src/routing/service";
import {
  OpenBotChannelAgent,
  type OpenBotChannelAgentDependencies,
} from "../src/slack/channel-agent";
import {
  currentSlackExecution,
  runWithSlackExecution,
  type SlackExecution,
} from "../src/slack/execution-context";

const CANONICAL_THREAD_ID = "channels-thread-1";
const CONVERSATION_KEY = "slack:T1:C1:message-1";
const ACTOR = { id: "alice", role: "user" } as const;

function execution(overrides: Partial<SlackExecution> = {}): SlackExecution {
  return {
    actor: ACTOR,
    applicationUser: { id: "alice", name: "Alice" },
    provider: "slack",
    providerTenantId: "tenant-1",
    providerConversationId: "conversation-1",
    providerThreadId: "slack-thread-1",
    messageText: "Please review this risk.",
    ...overrides,
  };
}

function input(): RunAgentInput {
  return {
    threadId: CANONICAL_THREAD_ID,
    runId: "run-1",
    state: { existing: true },
    messages: [{ id: "message-1", role: "user", content: "original input" }],
    tools: [],
    context: [{ description: "ordinary context", value: "kept" }],
    forwardedProps: { ordinary: "kept" },
  };
}

function binding(
  overrides: Partial<ExternalThreadBinding> = {},
): ExternalThreadBinding {
  return {
    channelsThreadId: CANONICAL_THREAD_ID,
    provider: "slack",
    providerTenantId: "tenant-1",
    providerConversationId: "conversation-1",
    providerThreadId: "slack-thread-1",
    agentId: "risk",
    agentName: "Risk Analyst",
    createdByUserId: "alice",
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
    ...overrides,
  };
}

class ScriptedAgent extends AbstractAgent {
  readonly received: RunAgentInput[] = [];
  aborts = 0;

  constructor(
    readonly script: (input: RunAgentInput) => Observable<BaseEvent> = () =>
      EMPTY,
  ) {
    super({ agentId: "scripted", description: "scripted target" });
  }

  run(runInput: RunAgentInput): Observable<BaseEvent> {
    this.received.push(runInput);
    return this.script(runInput);
  }

  abortRun(): void {
    this.aborts += 1;
    super.abortRun();
  }
}

function harness(
  options: {
    existing?: ExternalThreadBinding | null;
    bound?: ExternalThreadBinding;
    route?: Awaited<ReturnType<CoworkerRoutingService["route"]>>;
    resolve?: ActorAgentResolver["resolveAgentForActor"];
  } = {},
) {
  const getCalls: string[] = [];
  const bindCalls: Parameters<ExternalThreadStore["bind"]>[0][] = [];
  const transcriptCalls: Parameters<
    ExternalThreadStore["appendTranscriptTurn"]
  >[0][] = [];
  const routeCalls: Parameters<CoworkerRoutingService["route"]>[0][] = [];
  const resolveCalls: Parameters<ActorAgentResolver["resolveAgentForActor"]>[] =
    [];
  const target = new ScriptedAgent(() =>
    of(
      { type: "CUSTOM", name: "first", value: 1 } as BaseEvent,
      { type: "CUSTOM", name: "second", value: 2 } as BaseEvent,
    ),
  );
  const store: ExternalThreadStore = {
    async getByChannelsThreadId(id) {
      getCalls.push(id);
      return options.existing ?? null;
    },
    async getByProviderThread() {
      return null;
    },
    async bind(value) {
      bindCalls.push(value);
      return (
        options.bound ??
        binding({
          ...value,
          createdAt: new Date("2026-08-27T00:00:00.000Z"),
        })
      );
    },
    async appendTranscriptTurn(value) {
      transcriptCalls.push(value);
    },
    async getTranscript() {
      return [];
    },
  };
  const routing: CoworkerRoutingService = {
    async route(value) {
      routeCalls.push(value);
      return (
        options.route ?? {
          kind: "selected",
          agentId: "risk",
          name: "Risk Analyst",
          reason: "requested",
          fallback: false,
          viaMention: false,
        }
      );
    },
  };
  const resolver: ActorAgentResolver = {
    async resolveAgentsForActor() {
      return {};
    },
    async resolveAgentForActor(actor, agentId) {
      resolveCalls.push([actor, agentId]);
      return options.resolve
        ? options.resolve(actor, agentId)
        : Promise.resolve(target);
    },
  };
  const deps: OpenBotChannelAgentDependencies = { routing, store, resolver };

  return {
    agent: new OpenBotChannelAgent(CONVERSATION_KEY, deps),
    target,
    getCalls,
    bindCalls,
    routeCalls,
    resolveCalls,
    transcriptCalls,
    deps,
  };
}

async function collect(agent: OpenBotChannelAgent, runInput = input()) {
  return runWithSlackExecution(execution(), () =>
    lastValueFrom(agent.run(runInput).pipe(toArray())),
  );
}

describe("OpenBotChannelAgent", () => {
  test("uses private execution bound before Channels invokes the agent", async () => {
    const { deps } = harness();
    const agent = new OpenBotChannelAgent(CONVERSATION_KEY, deps, execution());

    const events = await lastValueFrom(agent.run(input()).pipe(toArray()));

    expect(events).toHaveLength(2);
  });

  test("carries private execution into a deferred Channels subscription", async () => {
    const { agent } = harness();
    const deferredRun = runWithSlackExecution(execution(), () =>
      agent.run(input()),
    );

    const events = await lastValueFrom(deferredRun.pipe(toArray()));

    expect(events).toHaveLength(2);
  });

  test("routes a first Slack turn, binds its trusted identity, and forwards events", async () => {
    const { agent, target, getCalls, bindCalls, routeCalls, resolveCalls } =
      harness();
    const events = await collect(agent);

    expect(getCalls).toEqual([CANONICAL_THREAD_ID]);
    expect(routeCalls).toEqual([
      { actor: ACTOR, text: "Please review this risk." },
    ]);
    expect(bindCalls).toEqual([
      {
        channelsThreadId: CANONICAL_THREAD_ID,
        provider: "slack",
        providerTenantId: "tenant-1",
        providerConversationId: "conversation-1",
        providerThreadId: "slack-thread-1",
        agentId: "risk",
        agentName: "Risk Analyst",
        createdByUserId: "alice",
      },
    ]);
    expect(resolveCalls).toEqual([[ACTOR, "risk"]]);
    expect(target.received).toHaveLength(1);
    expect(events).toEqual([
      { type: "CUSTOM", name: "first", value: 1 },
      { type: "CUSTOM", name: "second", value: 2 },
    ]);
  });

  test("durably records the provider-visible user and assistant turn before completing", async () => {
    const reply = new ScriptedAgent(() =>
      of(
        {
          type: "TEXT_MESSAGE_START",
          messageId: "reply-1",
          role: "assistant",
        } as BaseEvent,
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "reply-1",
          delta: "Recorded reply",
        } as BaseEvent,
        { type: "TEXT_MESSAGE_END", messageId: "reply-1" } as BaseEvent,
      ),
    );
    const { agent, transcriptCalls } = harness({
      resolve: async () => reply,
    });

    await collect(agent);

    expect(transcriptCalls).toEqual([
      {
        channelsThreadId: CANONICAL_THREAD_ID,
        user: {
          id: "message-1",
          role: "user",
          content: "Please review this risk.",
        },
        assistant: {
          id: "reply-1",
          role: "assistant",
          content: "Recorded reply",
        },
      },
    ]);
  });

  test("records the compact text chunk form emitted by built-in agents", async () => {
    const reply = new ScriptedAgent(() =>
      of({ type: "TEXT_MESSAGE_CHUNK", delta: "Compact reply" } as BaseEvent),
    );
    const { agent, transcriptCalls } = harness({
      resolve: async () => reply,
    });

    await collect(agent);

    expect(transcriptCalls).toHaveLength(1);
    expect(transcriptCalls[0]).toMatchObject({
      channelsThreadId: CANONICAL_THREAD_ID,
      user: { id: "message-1", content: "Please review this risk." },
      assistant: { role: "assistant", content: "Compact reply" },
    });
    expect(transcriptCalls[0]?.assistant.id).toBeString();
  });

  test("uses an established binding and resolves it freshly for the current speaker", async () => {
    const { agent, bindCalls, routeCalls, resolveCalls } = harness({
      existing: binding({ agentId: "knowledge", agentName: "Knowledge" }),
    });
    await runWithSlackExecution(
      execution({ actor: { id: "bob", role: "user" } }),
      () => lastValueFrom(agent.run(input()).pipe(toArray())),
    );

    expect(routeCalls).toEqual([]);
    expect(bindCalls).toEqual([]);
    expect(resolveCalls).toEqual([[{ id: "bob", role: "user" }, "knowledge"]]);
  });

  test("resolves the binding winner when another first writer won the thread", async () => {
    const { agent, bindCalls, resolveCalls } = harness({
      bound: binding({ agentId: "winner", agentName: "Thread Winner" }),
    });

    await collect(agent);

    expect(bindCalls[0]?.agentId).toBe("risk");
    expect(resolveCalls).toEqual([[ACTOR, "winner"]]);
  });

  test("keeps a linked coworker pinned when the current participant loses access", async () => {
    const { agent, bindCalls, routeCalls } = harness({
      existing: binding({ agentId: "private-risk", agentName: "Private Risk" }),
      resolve: async () => {
        throw new Error("Coworker private-risk is unavailable to this user.");
      },
    });

    await expect(collect(agent)).rejects.toThrow(
      "Coworker private-risk is unavailable to this user.",
    );
    expect(bindCalls).toEqual([]);
    expect(routeCalls).toEqual([]);
  });

  test("rejects a first turn with the stable no-coworker error", async () => {
    const { agent, bindCalls } = harness({ route: { kind: "none" } });

    await expect(collect(agent)).rejects.toThrow(
      "No coworker is available to you.",
    );
    expect(bindCalls).toEqual([]);
  });

  test("lists every ambiguous coworker name without assuming a service shape", async () => {
    const { agent } = harness({
      route: { kind: "ambiguous", names: ["A", "B"] },
    });

    await expect(collect(agent)).rejects.toThrow("Name one coworker: A, B.");
  });

  test("delegates the exact original input without leaking private Slack execution", async () => {
    const { agent, target } = harness();
    const original = input();
    await runWithSlackExecution(execution(), () =>
      lastValueFrom(agent.run(original).pipe(toArray())),
    );

    expect(target.received[0]).toBe(original);
    for (const property of [
      "provider",
      "providerTenantId",
      "providerConversationId",
      "providerThreadId",
      "applicationUser",
      "actor",
      "messageText",
      "channelsThreadId",
      "agentId",
    ]) {
      expect(target.received[0]).not.toHaveProperty(property);
    }
    expect(target.received[0].context).toBe(original.context);
    expect(target.received[0].forwardedProps).toBe(original.forwardedProps);
    expect(target.received[0].messages).toBe(original.messages);
  });

  test("composes a resolved remote coworker before the channel delegates its direct run", async () => {
    const requests: RunAgentInput[] = [];
    const fetch = async (_url: string, request: RequestInit) => {
      const sent = JSON.parse(String(request.body)) as RunAgentInput;
      requests.push(sent);
      return new Response(
        [
          { type: "RUN_STARTED", threadId: sent.threadId, runId: sent.runId },
          { type: "RUN_FINISHED", threadId: sent.threadId, runId: sent.runId },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const resolver = createActorAgentResolver({
      loadAgents: async () => [
        {
          id: "risk",
          name: "Risk Analyst",
          type: "remote_ag_ui" as const,
          endpoint: "https://coworker.example/ag-ui",
          standingMessage: {
            id: "standing-role:risk",
            role: "system" as const,
            content: "You are the risk coworker.",
          },
        },
      ],
      model: { provider: "openai", defaultModel: "gpt-5.6-terra" },
      resolveModelApiKey: async () => null,
      loadToolsForActor: (actorId) => async () => [
        {
          name: "mcp__risk__lookup",
          description: "Look up a risk record.",
          parameters: z.object({ recordId: z.string() }),
          ref: "risk/lookup",
          execute: async () => actorId,
        },
      ],
      signRunForActor: (actorId) => (botId, runId) =>
        `signed:${actorId}:${botId}:${runId}`,
      agentFetch: fetch,
    });
    const { agent } = harness({
      resolve: resolver.resolveAgentForActor,
    });

    await collect(agent);

    const sent = requests[0];
    expect(
      sent?.messages.filter((message) => message.id === "standing-role:risk"),
    ).toHaveLength(1);
    expect(sent?.messages[0]).toMatchObject({
      id: "standing-role:risk",
      role: "system",
    });
    expect(
      sent?.messages.find((message) => message.id === "granted-tools:risk")
        ?.content,
    ).toContain("risk");
    expect(sent?.tools).toContainEqual(
      expect.objectContaining({
        name: "mcp__risk__lookup",
        description: "Look up a risk record.",
        parameters: expect.objectContaining({
          type: "object",
          properties: { recordId: { type: "string" } },
          required: ["recordId"],
          additionalProperties: false,
        }),
      }),
    );
    expect(sent?.forwardedProps).toMatchObject({
      openbotBotId: "risk",
      openbotDeploymentTools: ["mcp__risk__lookup"],
      openbotRun: "signed:alice:risk:run-1",
    });
    for (const privateProperty of [
      "provider",
      "providerTenantId",
      "providerConversationId",
      "providerThreadId",
      "applicationUser",
      "actor",
      "messageText",
      "channelsThreadId",
      "agentId",
    ]) {
      expect(sent).not.toHaveProperty(privateProperty);
    }
  });

  test("only updates current mutable routing fields in the private execution", async () => {
    const { agent } = harness();
    await runWithSlackExecution(execution(), async () => {
      const current = currentSlackExecution();
      await lastValueFrom(agent.run(input()).pipe(toArray()));
      expect(current.channelsThreadId).toBe(CANONICAL_THREAD_ID);
      expect(current.agentId).toBe("risk");
      expect(current).toMatchObject({
        actor: ACTOR,
        applicationUser: { id: "alice", name: "Alice" },
        provider: "slack",
        providerTenantId: "tenant-1",
        providerConversationId: "conversation-1",
        providerThreadId: "slack-thread-1",
        messageText: "Please review this risk.",
      });
    });
  });

  test("clones preserve the AbstractAgent base contract and keep delegate abort state independent", async () => {
    const first = new ScriptedAgent(() => NEVER);
    const second = new ScriptedAgent(() => NEVER);
    const { agent, deps } = harness({
      existing: binding(),
      resolve: async (actor) => (actor.id === "alice" ? first : second),
    });
    agent.agentId = "custom-slack-router";
    agent.description = "Custom channel router";
    agent.threadId = "configured-thread";
    agent.setMessages([{ id: "saved", role: "user", content: "saved" }]);
    agent.setState({ saved: true });
    agent.pendingInterrupts = [{ id: "interrupt-1" }] as never;
    agent.debug = true;
    const subscriber = {};
    agent.subscribe(subscriber);
    const clone = agent.clone();
    expect(clone).toBeInstanceOf(OpenBotChannelAgent);
    expect(clone).not.toBe(agent);
    expect(clone.agentId).toBe("custom-slack-router");
    expect(clone.description).toBe("Custom channel router");
    expect(clone.threadId).toBe("configured-thread");
    expect(clone.messages).toEqual([
      { id: "saved", role: "user", content: "saved" },
    ]);
    expect(clone.messages).not.toBe(agent.messages);
    expect(clone.state).toEqual({ saved: true });
    expect(clone.state).not.toBe(agent.state);
    expect(clone.pendingInterrupts).toEqual([{ id: "interrupt-1" }]);
    expect(clone.pendingInterrupts).not.toBe(agent.pendingInterrupts);
    expect(clone.debug).toEqual(agent.debug);
    expect(clone.subscribers).toEqual([subscriber]);
    expect(clone.subscribers).not.toBe(agent.subscribers);

    const originalSubscription = runWithSlackExecution(execution(), () =>
      agent.run(input()).subscribe(),
    );
    const cloneSubscription = runWithSlackExecution(
      execution({ actor: { id: "bob", role: "user" } }),
      () => clone.run(input()).subscribe(),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);
    agent.abortRun();
    expect(first.aborts).toBe(1);
    expect(second.aborts).toBe(0);
    originalSubscription.unsubscribe();
    cloneSubscription.unsubscribe();
    expect(deps).toBeDefined();
  });

  test("rejects overlap before a delegate resolves, then accepts a sequential run", async () => {
    let resolveFirst!: (target: AbstractAgent) => void;
    const first = new Promise<AbstractAgent>(
      (resolve) => (resolveFirst = resolve),
    );
    const next = new ScriptedAgent(() =>
      of({ type: "CUSTOM", name: "next", value: true } as BaseEvent),
    );
    let calls = 0;
    const { agent } = harness({
      existing: binding(),
      resolve: async () => (calls++ === 0 ? first : next),
    });
    const running = runWithSlackExecution(execution(), () =>
      lastValueFrom(agent.run(input()).pipe(toArray())),
    );
    await Promise.resolve();

    await expect(
      runWithSlackExecution(execution(), () =>
        lastValueFrom(agent.run(input()).pipe(toArray())),
      ),
    ).rejects.toThrow("OpenBot Slack agent is already running.");
    agent.abortRun();
    await expect(running).resolves.toEqual([]);
    resolveFirst(new ScriptedAgent(() => NEVER));
    await Promise.resolve();

    await expect(collect(agent)).resolves.toEqual([
      { type: "CUSTOM", name: "next", value: true },
    ]);
  });

  test("rejects overlap after a delegate starts without orphaning the first delegate", async () => {
    const target = new ScriptedAgent(() => NEVER);
    const { agent } = harness({
      existing: binding(),
      resolve: async () => target,
    });
    const running = runWithSlackExecution(execution(), () =>
      lastValueFrom(agent.run(input()).pipe(toArray())),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(target.received).toHaveLength(1);

    await expect(
      runWithSlackExecution(execution(), () =>
        lastValueFrom(agent.run(input()).pipe(toArray())),
      ),
    ).rejects.toThrow("OpenBot Slack agent is already running.");
    agent.abortRun();
    await expect(running).resolves.toEqual([]);
    expect(target.aborts).toBe(1);
  });

  test("cancels a hanging resolution without aborting its eventual target or leaking its rejection", async () => {
    let rejectFirst!: (error: Error) => void;
    const pending = new Promise<AbstractAgent>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const reusable = new ScriptedAgent(() =>
      of({ type: "CUSTOM", name: "reused", value: true } as BaseEvent),
    );
    let calls = 0;
    const { agent } = harness({
      existing: binding(),
      resolve: async () => {
        calls += 1;
        return calls === 1 ? pending : reusable;
      },
    });
    const running = runWithSlackExecution(execution(), () =>
      lastValueFrom(agent.run(input()).pipe(toArray())),
    );
    await Promise.resolve();
    agent.abortRun();
    await expect(running).resolves.toEqual([]);
    rejectFirst(new Error("late resolver failure"));
    await Promise.resolve();
    expect(reusable.aborts).toBe(0);

    await expect(collect(agent)).resolves.toEqual([
      { type: "CUSTOM", name: "reused", value: true },
    ]);
    expect(reusable.aborts).toBe(0);
  });

  test("aborts a started target once and aborts started work on unsubscribe", async () => {
    const first = new ScriptedAgent(() => NEVER);
    const second = new ScriptedAgent(() => NEVER);
    let calls = 0;
    const { agent } = harness({
      existing: binding(),
      resolve: async () => (calls++ === 0 ? first : second),
    });
    const active = runWithSlackExecution(execution(), () =>
      lastValueFrom(agent.run(input()).pipe(toArray())),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    agent.abortRun();
    await expect(active).resolves.toEqual([]);
    expect(first.aborts).toBe(1);

    const subscription = runWithSlackExecution(execution(), () =>
      agent.run(input()).subscribe(),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    subscription.unsubscribe();
    expect(second.aborts).toBe(1);
  });

  test("an abort before resolution cannot abort a later run's target", async () => {
    let resolveFirst!: (agent: AbstractAgent) => void;
    const firstResolution = new Promise<AbstractAgent>((resolve) => {
      resolveFirst = resolve;
    });
    const oldTarget = new ScriptedAgent(() => NEVER);
    const futureTarget = new ScriptedAgent(() => NEVER);
    let calls = 0;
    const { agent } = harness({
      existing: binding(),
      resolve: async () => {
        calls += 1;
        return calls === 1 ? firstResolution : futureTarget;
      },
    });

    const oldSubscription = runWithSlackExecution(execution(), () =>
      agent.run(input()).subscribe(),
    );
    await Promise.resolve();
    agent.abortRun();
    const futureSubscription = runWithSlackExecution(execution(), () =>
      agent.run(input()).subscribe(),
    );
    await Promise.resolve();
    await Promise.resolve();
    resolveFirst(oldTarget);
    await Promise.resolve();

    expect(futureTarget.aborts).toBe(0);
    expect(oldTarget.aborts).toBe(0);
    oldSubscription.unsubscribe();
    futureSubscription.unsubscribe();
  });

  test("propagates resolver and delegated run failures through its observable", async () => {
    const resolverFailure = harness({
      existing: binding(),
      resolve: async () => {
        throw new Error("resolver failed");
      },
    });
    await expect(collect(resolverFailure.agent)).rejects.toThrow(
      "resolver failed",
    );

    const targetFailure = new ScriptedAgent(() =>
      throwError(() => new Error("target failed")),
    );
    const delegatedFailure = harness({
      existing: binding(),
      resolve: async () => targetFailure,
    });
    await expect(collect(delegatedFailure.agent)).rejects.toThrow(
      "target failed",
    );
  });
});
