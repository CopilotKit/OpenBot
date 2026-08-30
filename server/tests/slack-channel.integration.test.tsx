import { describe, expect, test } from "bun:test";
import { AsyncResource } from "node:async_hooks";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import type {
  ChannelIdentityContext,
  ChannelNode,
  IncomingTurn,
  InteractionEvent,
  PlatformAdapter,
  StateStore,
} from "@copilotkit/channels";
import { MemoryStore } from "@copilotkit/channels";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { Observable } from "rxjs";
import { z } from "zod";
import {
  type ActorAgentResolver,
  createActorAgentResolver,
} from "../src/agents/agent-resolver";
import type { ComputerGateway } from "../src/computer/gateway";
import type {
  ExternalThreadBinding,
  ExternalThreadStore,
} from "../src/external/thread-store";
import type { CoworkerRoutingService } from "../src/routing/service";
import { createApprovalAuthorizer } from "../src/slack/approval-authorizer";
import type { ApprovalPresentation } from "../src/slack/approval-store";
import {
  createOpenBotSlackChannel,
  type OpenBotSlackChannelDependencies,
} from "../src/slack/channel";
import { configureApprovalDecisionStore } from "../src/slack/components";
import type { SlackIdentityResult } from "../src/slack/identity-linker";
import { SlackIngressRegistry } from "../src/slack/ingress-registry";
import type {
  SlackTurnFailureEvent,
  SlackTurnFailureLogger,
} from "../src/slack/turn-phase";

type SharedRunState = {
  inputs: RunAgentInput[];
  active: number;
  maxActive: number;
  blockRuns: boolean;
  pendingFinishes: Array<() => void>;
  requestApproval: boolean;
  approvalPresented: boolean;
  toolCall?: { name: string; args: Record<string, unknown> };
  toolPresented: boolean;
};

type FakeAdapterInstance = PlatformAdapter & {
  posted: ChannelNode[][];
  stateStore?: StateStore;
  getCanonicalThreadId?: PlatformAdapter["getCanonicalThreadId"];
  getSink(): {
    onTurn(turn: IncomingTurn): void | Promise<void>;
    onInteraction(event: InteractionEvent): void | Promise<void>;
  };
};

class ShareComputerGateway implements ComputerGateway {
  readonly navigateCalls: Parameters<ComputerGateway["navigate"]>[] = [];
  readonly readFileCalls: Parameters<ComputerGateway["readFile"]>[] = [];
  readFileResult: Awaited<ReturnType<ComputerGateway["readFile"]>> = {
    path: "reports/risk.txt",
    text: "Résumé 📊",
    truncated: false,
    bytes: 13,
  };

  async readFile(...args: Parameters<ComputerGateway["readFile"]>) {
    this.readFileCalls.push(args);
    return this.readFileResult;
  }
  async status(): Promise<never> {
    throw new Error("unused");
  }
  async screenshot(): Promise<never> {
    throw new Error("unused");
  }
  async snapshot(): Promise<never> {
    throw new Error("unused");
  }
  async read(): Promise<never> {
    throw new Error("unused");
  }
  async navigate(...args: Parameters<ComputerGateway["navigate"]>) {
    this.navigateCalls.push(args);
    return {
      url: args[2],
      title: "CopilotKit",
      status: 200,
      elapsedMs: 1,
    };
  }
  async click(): Promise<never> {
    throw new Error("unused");
  }
  async type(): Promise<never> {
    throw new Error("unused");
  }
  async key(): Promise<never> {
    throw new Error("unused");
  }
  async scroll(): Promise<never> {
    throw new Error("unused");
  }
  async listFiles(): Promise<never> {
    throw new Error("unused");
  }
  async runCommand(): Promise<never> {
    throw new Error("unused");
  }
  async writeFile(): Promise<never> {
    throw new Error("unused");
  }
  async control(): Promise<never> {
    throw new Error("unused");
  }
  async requestHelp(): Promise<never> {
    throw new Error("unused");
  }
  async cancelAssistance(): Promise<never> {
    throw new Error("unused");
  }
  async assistanceStatus(): Promise<never> {
    throw new Error("unused");
  }
  async takeControl(): Promise<never> {
    throw new Error("unused");
  }
  async releaseControl(): Promise<never> {
    throw new Error("unused");
  }
  async requestSecret(): Promise<never> {
    throw new Error("unused");
  }
  async supplySecret(): Promise<never> {
    throw new Error("unused");
  }
  async humanInput(): Promise<never> {
    throw new Error("unused");
  }
  async computers(): Promise<never> {
    throw new Error("unused");
  }
  async stopComputer(): Promise<never> {
    throw new Error("unused");
  }
  async resetComputer(): Promise<never> {
    throw new Error("unused");
  }
}

type FakeAdapterConstructor = new (options: {
  platform: string;
  messageEvents: boolean;
}) => FakeAdapterInstance;

// Channels 0.9's umbrella testing export accidentally points at the core conformance helper.
// Resolve the package's own core dependency so this still exercises the SDK's shipped FakeAdapter.
const channelsEntry = import.meta.resolve("@copilotkit/channels");
const fakeAdapterModule = new URL(
  "../../channels-core/dist/testing/fake-adapter.js",
  channelsEntry,
).href;
const { FakeAdapter } = (await import(fakeAdapterModule)) as {
  FakeAdapter: FakeAdapterConstructor;
};

class ReplyAgent extends AbstractAgent {
  constructor(private readonly shared: SharedRunState) {
    super({ agentId: "risk", description: "Risk Analyst" });
  }

  override clone(): ReplyAgent {
    return new ReplyAgent(this.shared);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.shared.inputs.push(input);
    this.shared.active += 1;
    this.shared.maxActive = Math.max(this.shared.maxActive, this.shared.active);
    return new Observable((subscriber) => {
      const finish = () => {
        const messageId = `reply-${this.shared.inputs.length}`;
        subscriber.next({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        });
        if (
          this.shared.toolCall &&
          !this.shared.toolPresented &&
          !input.forwardedProps?.command
        ) {
          this.shared.toolPresented = true;
          subscriber.next({
            type: "TOOL_CALL_START",
            toolCallId: "channel-tool-call-1",
            toolCallName: this.shared.toolCall.name,
            parentMessageId: "",
          });
          subscriber.next({
            type: "TOOL_CALL_ARGS",
            toolCallId: "channel-tool-call-1",
            delta: JSON.stringify(this.shared.toolCall.args),
          });
          subscriber.next({
            type: "TOOL_CALL_END",
            toolCallId: "channel-tool-call-1",
          });
        } else if (
          this.shared.requestApproval &&
          !this.shared.approvalPresented &&
          !input.forwardedProps?.command
        ) {
          this.shared.approvalPresented = true;
          subscriber.next({
            type: "TOOL_CALL_START",
            toolCallId: "approval-call-1",
            toolCallName: "approval_card",
            parentMessageId: "",
          });
          subscriber.next({
            type: "TOOL_CALL_ARGS",
            toolCallId: "approval-call-1",
            delta: JSON.stringify({ question: "Deploy this release?" }),
          });
          subscriber.next({
            type: "TOOL_CALL_END",
            toolCallId: "approval-call-1",
          });
        } else {
          subscriber.next({
            type: "TEXT_MESSAGE_START",
            messageId,
            role: "assistant",
          });
          subscriber.next({
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: "review complete",
          });
          subscriber.next({
            type: "TEXT_MESSAGE_END",
            messageId,
          });
        }
        subscriber.next({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        });
        this.shared.active -= 1;
        subscriber.complete();
      };
      if (this.shared.blockRuns) this.shared.pendingFinishes.push(finish);
      else finish();
    });
  }
}

function identity(
  eventId: string,
  actorId: string,
  tenantId = "T1",
  conversationId = "C1",
  providerThreadId = "provider-thread-1",
): ChannelIdentityContext {
  return {
    provider: "slack",
    tenant: { id: tenantId },
    installation: { id: "I1" },
    actor: { id: actorId, kind: "human", name: actorId },
    conversation: { id: conversationId },
    trigger: "message",
    event: { id: eventId, threadId: providerThreadId },
    raw: null,
  };
}

function interactionIdentity(
  eventId: string,
  actorId: string,
  tenantId = "T1",
  conversationId = "C1",
  providerThreadId = "provider-thread-1",
): ChannelIdentityContext {
  return {
    ...identity(eventId, actorId, tenantId, conversationId, providerThreadId),
    trigger: "interaction",
  };
}

function turn(
  eventId: string,
  text: string,
  options: {
    actorId?: string;
    mentioned?: boolean;
    kind?: "created" | "updated" | "deleted";
    tenantId?: string;
    conversationId?: string;
    conversationKey?: string;
    logicalMessageId?: string;
    providerThreadId?: string;
    canonicalThreadId?: string;
  } = {},
) {
  const actorId = options.actorId ?? "U1";
  const kind = options.kind ?? "created";
  const tenantId = options.tenantId ?? "T1";
  const conversationId = options.conversationId ?? "C1";
  return {
    eventId,
    conversationKey:
      options.conversationKey ?? `opaque-conversation-${conversationId}`,
    replyTarget: {
      canonicalThreadId: options.canonicalThreadId ?? "canonical-thread-1",
    },
    userText: text,
    platform: "slack",
    actor: { id: actorId, kind: "human" as const, name: actorId },
    identityContext: identity(
      eventId,
      actorId,
      tenantId,
      conversationId,
      options.providerThreadId,
    ),
    operation: {
      kind,
      logicalMessageId: options.logicalMessageId ?? eventId,
      revisionId: `${eventId}:${kind}`,
      mentioned: options.mentioned ?? true,
    },
  };
}

function postedText(adapter: FakeAdapter): string {
  return JSON.stringify(adapter.posted);
}

function actionIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const node = value as { props?: Record<string, unknown> };
  const onClick = node.props?.onClick;
  const own =
    onClick && typeof onClick === "object" && "id" in onClick
      ? [String(onClick.id)]
      : [];
  const children = node.props?.children;
  return [
    ...own,
    ...(Array.isArray(children)
      ? children.flatMap(actionIds)
      : actionIds(children)),
  ];
}

function harness(
  options: {
    computerGateway?: ComputerGateway;
    postFileResult?: Awaited<
      ReturnType<NonNullable<PlatformAdapter["postFile"]>>
    >;
    stateStore?: StateStore;
    shared?: SharedRunState;
    bindings?: Map<string, ExternalThreadBinding>;
    identityLinker?: OpenBotSlackChannelDependencies["identityLinker"];
    ingressRegistry?: SlackIngressRegistry;
    logTurnFailure?: SlackTurnFailureLogger;
    resolver?: ActorAgentResolver;
    agentId?: string;
    failPost?: boolean;
    failSubscribe?: boolean;
    failExecutionPrepare?: boolean;
    configuredTenantId?: string;
    detachThreadOperations?: boolean;
    cacheAgents?: boolean;
  } = {},
) {
  const adapter = new FakeAdapter({ platform: "slack", messageEvents: true });
  const events: SlackTurnFailureEvent[] = [];
  adapter.getCanonicalThreadId = (target) => {
    const id = (target as { canonicalThreadId?: unknown }).canonicalThreadId;
    if (typeof id !== "string" || !id) {
      throw new Error("fake delivery requires a canonical thread id");
    }
    return id;
  };
  const cachedAgents = new Map<string, AbstractAgent>();
  adapter.conversationStore.getOrCreate = async (
    conversationKey,
    _replyTarget,
    makeAgent,
  ) => {
    const cached = options.cacheAgents
      ? cachedAgents.get(conversationKey)
      : undefined;
    const agent = cached ?? makeAgent(conversationKey);
    if (options.cacheAgents) cachedAgents.set(conversationKey, agent);
    return { agent };
  };
  if (options.detachThreadOperations) {
    const detached = new AsyncResource("detached-channel-operation");
    adapter.trackThreadOperation = (_target, operation) =>
      detached.runInAsyncScope(operation);
  }
  adapter.stateStore = options.stateStore;
  if (options.failSubscribe) {
    const backing = new MemoryStore();
    adapter.stateStore = {
      kv: {
        ...backing.kv,
        async set(key, value, ttlMs) {
          if (key.startsWith("sub:")) throw new Error("subscribe failed");
          await backing.kv.set(key, value, ttlMs);
        },
      },
      list: backing.list,
      lock: backing.lock,
      dedup: backing.dedup,
      queue: backing.queue,
    };
  }
  if (options.failPost) {
    adapter.post = async () => {
      throw new Error("post failed");
    };
  }
  const filePosts: Parameters<NonNullable<PlatformAdapter["postFile"]>>[] = [];
  adapter.postFile = async (...args) => {
    filePosts.push(args);
    return options.postFileResult ?? { ok: true, fileId: "F1" };
  };
  const createRunRenderer = adapter.createRunRenderer.bind(adapter);
  adapter.createRunRenderer = (target) => {
    const renderer = createRunRenderer(target);
    const onText = renderer.subscriber.onTextMessageContentEvent?.bind(
      renderer.subscriber,
    );
    let streamed = "";
    renderer.subscriber.onTextMessageContentEvent = (event) => {
      streamed += event.event.delta;
      onText?.(event);
    };
    const finish = renderer.finish?.bind(renderer);
    renderer.finish = async () => {
      if (streamed) {
        adapter.posted.push([{ type: "text", props: { value: streamed } }]);
      }
      await finish?.();
    };
    return renderer;
  };
  const bindings = options.bindings ?? new Map<string, ExternalThreadBinding>();
  const bindCalls: Parameters<ExternalThreadStore["bind"]>[0][] = [];
  const shared: SharedRunState = options.shared ?? {
    inputs: [],
    active: 0,
    maxActive: 0,
    blockRuns: false,
    pendingFinishes: [],
    requestApproval: false,
    approvalPresented: false,
    toolPresented: false,
  };
  const target = new ReplyAgent(shared);
  const actors: string[] = [];
  const linker = {
    async resolve(
      context: ChannelIdentityContext,
    ): Promise<SlackIdentityResult> {
      const providerUserId = context.actor.id;
      if (providerUserId === "UNLINKED") {
        return {
          kind: "unlinked",
          linkUrl: "https://openbot.test/link/slack?token=opaque",
          identity: {
            provider: "slack",
            providerTenantId: context.tenant.id,
            providerUserId,
            providerEmail: null,
          },
        };
      }
      return {
        kind: "linked",
        user: { id: providerUserId.toLowerCase(), name: providerUserId },
        actor: { id: providerUserId.toLowerCase(), role: "user" },
        identity: {
          provider: "slack",
          providerTenantId: context.tenant.id,
          providerUserId,
          providerEmail: null,
        },
      };
    },
  };
  const store: ExternalThreadStore = {
    async getByChannelsThreadId(id) {
      return bindings.get(id) ?? null;
    },
    async getByProviderThread(identity) {
      return (
        [...bindings.values()].find(
          (binding) =>
            binding.provider === identity.provider &&
            binding.providerTenantId === identity.providerTenantId &&
            binding.providerConversationId ===
              identity.providerConversationId &&
            binding.providerThreadId === identity.providerThreadId,
        ) ?? null
      );
    },
    async bind(input) {
      bindCalls.push(input);
      const value = {
        ...input,
        createdAt: new Date("2026-08-27T00:00:00.000Z"),
      };
      bindings.set(input.channelsThreadId, value);
      return value;
    },
    async appendTranscriptTurn() {},
    async getTranscript() {
      return [];
    },
  };
  const routing: CoworkerRoutingService = {
    async route() {
      return {
        kind: "selected",
        agentId: options.agentId ?? "risk",
        name: "Risk Analyst",
        reason: "requested",
        fallback: false,
        viaMention: true,
      };
    },
  };
  const resolver: ActorAgentResolver = {
    async resolveAgentsForActor() {
      return { risk: target };
    },
    async resolveAgentForActor(actor) {
      actors.push(actor.id);
      return target;
    },
  };
  const deps: OpenBotSlackChannelDependencies = {
    appUrl: "https://openbot.test",
    identityLinker: options.identityLinker ?? linker,
    configuredTenantId: options.configuredTenantId,
    agentDeps: { routing, store, resolver: options.resolver ?? resolver },
    ingressRegistry: options.ingressRegistry,
    computerGateway: options.computerGateway,
    logTurnFailure: options.logTurnFailure ?? ((event) => events.push(event)),
    prepareExecution: options.failExecutionPrepare
      ? () => {
          throw new Error("prepare failed");
        }
      : undefined,
  };
  const channel = createOpenBotSlackChannel(deps);
  channel.ɵruntime.addAdapter(adapter);
  return {
    adapter,
    channel,
    bindings,
    bindCalls,
    shared,
    actors,
    filePosts,
    events,
  };
}

function toolResult(shared: SharedRunState): Record<string, unknown> {
  const message = shared.inputs
    .flatMap(({ messages }) => messages)
    .findLast(({ role }) => role === "tool");
  if (message?.role !== "tool" || typeof message.content !== "string") {
    throw new Error("expected a channel tool result");
  }
  return JSON.parse(message.content) as Record<string, unknown>;
}

describe("managed OpenBot Slack channel", () => {
  test("does not emit in-message tool chunks before the assistant reply", () => {
    const { channel } = harness();

    expect(channel.showToolStatus).toBe(false);
  });

  test("uses the configured tenant once when managed delivery omits it", async () => {
    let seenContext: ChannelIdentityContext | undefined;
    const identityLinker: OpenBotSlackChannelDependencies["identityLinker"] = {
      async resolve(context) {
        seenContext = context;
        return {
          kind: "linked",
          user: { id: "u1", name: "User" },
          actor: { id: "u1", role: "user" },
          identity: {
            provider: "slack",
            providerTenantId: context.tenant.id,
            providerUserId: context.actor.id,
            providerEmail: null,
          },
        };
      },
    };
    const { adapter, bindCalls, channel, events, shared } = harness({
      configuredTenantId: "T05QFA4BW9X",
      identityLinker,
    });
    await channel.ɵruntime.start();

    await adapter
      .getSink()
      .onTurn(turn("E-tenant-fallback", "hello", { tenantId: "unknown" }));

    expect(seenContext?.tenant.id).toBe("T05QFA4BW9X");
    expect(bindCalls).toEqual([
      expect.objectContaining({
        providerTenantId: "T05QFA4BW9X",
        providerConversationId: "C1",
      }),
    ]);
    expect(shared.inputs).toHaveLength(1);
    expect(events).toEqual([]);
  });

  test("rejects a known managed tenant that conflicts with configuration", async () => {
    const ingressRegistry = new SlackIngressRegistry();
    let linkerCalls = 0;
    const identityLinker: OpenBotSlackChannelDependencies["identityLinker"] = {
      async resolve(context) {
        linkerCalls += 1;
        return {
          kind: "linked",
          user: { id: "u1", name: "User" },
          actor: { id: "u1", role: "user" },
          identity: {
            provider: "slack",
            providerTenantId: context.tenant.id,
            providerUserId: context.actor.id,
            providerEmail: null,
          },
        };
      },
    };
    const { adapter, bindCalls, channel, events, shared } = harness({
      configuredTenantId: "T1",
      identityLinker,
      ingressRegistry,
    });
    await channel.ɵruntime.start();

    await expect(
      adapter
        .getSink()
        .onTurn(turn("E-tenant-conflict", "hello", { tenantId: "T2" })),
    ).rejects.toThrow("Channel identifyUser failed");

    expect(linkerCalls).toBe(0);
    expect(
      ingressRegistry.take("E-tenant-conflict", {
        provider: "slack",
        providerActorId: "U1",
        applicationUserId: "u1",
      }),
    ).toBeNull();
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
    expect(events).toEqual([
      {
        type: "slack-turn-failed",
        phase: "identity.resolve",
        reason: "slack_identity_tenant_invalid",
      },
    ]);
  });

  test("fails closed when managed delivery omits tenant and no fallback is configured", async () => {
    const ingressRegistry = new SlackIngressRegistry();
    let linkerCalls = 0;
    const identityLinker: OpenBotSlackChannelDependencies["identityLinker"] = {
      async resolve() {
        linkerCalls += 1;
        throw new Error("linker must not run");
      },
    };
    const { adapter, bindCalls, channel, events, shared } = harness({
      identityLinker,
      ingressRegistry,
    });
    await channel.ɵruntime.start();

    await expect(
      adapter
        .getSink()
        .onTurn(turn("E-tenant-missing", "hello", { tenantId: "unknown" })),
    ).rejects.toThrow("Channel identifyUser failed");

    expect(linkerCalls).toBe(0);
    expect(
      ingressRegistry.take("E-tenant-missing", {
        provider: "slack",
        providerActorId: "U1",
        applicationUserId: null,
      }),
    ).toBeNull();
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
    expect(events).toEqual([
      {
        type: "slack-turn-failed",
        phase: "identity.resolve",
        reason: "slack_identity_tenant_invalid",
      },
    ]);
  });

  test("reports identity.resolve without leaking the error", async () => {
    const identityLinker: OpenBotSlackChannelDependencies["identityLinker"] = {
      async resolve() {
        throw new Error("secret identity detail");
      },
    };
    const { adapter, channel, events } = harness({ identityLinker });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-resolve-fail", "hello")),
    ).rejects.toThrow("Channel identifyUser failed");

    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "identity.resolve" },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret identity detail");
  });

  test("reports ingress.remember without leaking the error", async () => {
    class FailingRememberRegistry extends SlackIngressRegistry {
      override remember(): void {
        throw new Error("remember failed");
      }
    }

    const { adapter, channel, events } = harness({
      ingressRegistry: new FailingRememberRegistry(),
    });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-remember-fail", "hello")),
    ).rejects.toThrow("Channel identifyUser failed");

    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "ingress.remember" },
    ]);
  });

  test("reports ingress.take without binding or running", async () => {
    class FailingTakeRegistry extends SlackIngressRegistry {
      override take(): never {
        throw new Error("take failed");
      }
    }

    const { adapter, channel, bindCalls, events, shared } = harness({
      ingressRegistry: new FailingTakeRegistry(),
    });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-take-fail", "hello")),
    ).rejects.toThrow("take failed");

    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "ingress.take" },
    ]);
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
  });

  test("an unlinked mention posts a link without running or binding", async () => {
    const { adapter, channel, bindCalls, shared } = harness();
    await channel.ɵruntime.start();

    await adapter
      .getSink()
      .onTurn(turn("E-unlinked", "hello", { actorId: "UNLINKED" }));

    expect(postedText(adapter)).toContain("Link OpenBot account");
    expect(postedText(adapter)).toContain("opaque");
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
  });

  test("reports link_card.post without binding or running", async () => {
    const { adapter, channel, bindCalls, events, shared } = harness({
      failPost: true,
    });
    await channel.ɵruntime.start();

    await expect(
      adapter
        .getSink()
        .onTurn(
          turn("E-link-card-post-fail", "hello", { actorId: "UNLINKED" }),
        ),
    ).rejects.toThrow("post failed");

    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "link_card.post" },
    ]);
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
  });

  test("reports thread.subscribe without binding or running", async () => {
    const { adapter, channel, bindCalls, events, shared } = harness({
      failSubscribe: true,
    });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-thread-subscribe-fail", "hello")),
    ).rejects.toThrow("subscribe failed");

    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "thread.subscribe" },
    ]);
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
  });

  test("reports execution.prepare without binding or running", async () => {
    const { adapter, channel, bindCalls, events, shared } = harness({
      failExecutionPrepare: true,
    });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-execution-prepare-fail", "hello")),
    ).rejects.toThrow("prepare failed");

    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "execution.prepare" },
    ]);
    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
  });

  test("reports agent.run without serializing sensitive resolver details", async () => {
    const resolver: ActorAgentResolver = {
      async resolveAgentsForActor() {
        return {};
      },
      async resolveAgentForActor() {
        throw new Error("secret delegated run detail");
      },
    };
    const { adapter, channel, events, shared } = harness({ resolver });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-agent-run-fail", "hello")),
    ).rejects.toThrow("secret delegated run detail");

    expect(events).toEqual([{ type: "slack-turn-failed", phase: "agent.run" }]);
    expect(JSON.stringify(events)).not.toContain("secret delegated run detail");
    expect(shared.inputs).toEqual([]);
  });

  test("a linked mention subscribes, binds, and streams the pinned coworker", async () => {
    const { adapter, channel, bindCalls, shared } = harness();
    await channel.ɵruntime.start();

    await adapter
      .getSink()
      .onTurn(turn("E1", "ask Risk Analyst to review this"));

    expect(bindCalls[0]).toMatchObject({
      channelsThreadId: "opaque-conversation-C1",
      provider: "slack",
      providerTenantId: "T1",
      providerConversationId: "C1",
      providerThreadId: "provider-thread-1",
      agentId: "risk",
      createdByUserId: "u1",
    });
    expect(shared.inputs).toHaveLength(1);
    expect(postedText(adapter)).toContain("review complete");
    expect(postedText(adapter)).toContain(
      "https://openbot.test/slack/thread/opaque-conversation-C1",
    );
    expect(postedText(adapter)).toContain("Open in OpenBot");
  });

  test("carries private execution across the managed delivery operation boundary", async () => {
    const { adapter, channel, shared } = harness({
      detachThreadOperations: true,
    });
    await channel.ɵruntime.start();

    await adapter
      .getSink()
      .onTurn(turn("E-managed-boundary", "review this deployment"));

    expect(shared.inputs).toHaveLength(1);
    expect(postedText(adapter)).toContain("review complete");
  });

  test("treats managed conversation and canonical thread ids as opaque capabilities", async () => {
    const { adapter, channel, bindCalls } = harness();
    await channel.ɵruntime.start();

    await adapter.getSink().onTurn(
      turn("E-opaque", "review", {
        conversationKey: "opaque-conversation-capability-7f31",
        canonicalThreadId: "opaque-canonical-thread-a921",
        tenantId: "T1:attacker-looking-tenant",
        conversationId: "C1:attacker-looking-conversation",
        providerThreadId: "P1:attacker-looking-thread",
      }),
    );

    expect(bindCalls[0]).toMatchObject({
      channelsThreadId: "opaque-conversation-capability-7f31",
      providerTenantId: "T1:attacker-looking-tenant",
      providerConversationId: "C1:attacker-looking-conversation",
      providerThreadId: "P1:attacker-looking-thread",
    });
    expect(JSON.stringify(bindCalls[0])).not.toContain(
      "opaque-canonical-thread-a921",
    );
  });

  test("subscribed replies run without mentions and recheck each participant", async () => {
    const { adapter, channel, actors } = harness();
    await channel.ɵruntime.start();
    await adapter.getSink().onTurn(turn("E1", "start"));
    await adapter
      .getSink()
      .onTurn(turn("E2", "follow up", { actorId: "U2", mentioned: false }));

    expect(actors).toEqual(["u1", "u2"]);
  });

  test("ignores edits and deletions and deduplicates repeated creates", async () => {
    const { adapter, channel, shared } = harness();
    await channel.ɵruntime.start();
    const sink = adapter.getSink();
    await sink.onTurn(turn("E1", "start"));
    await sink.onTurn(turn("E1", "start"));
    await sink.onTurn(turn("E2", "edited", { kind: "updated" }));
    await sink.onTurn(turn("E3", "deleted", { kind: "deleted" }));

    expect(shared.inputs).toHaveLength(1);
  });

  for (const order of [
    ["U1", "U2"],
    ["U2", "U1"],
  ] as const) {
    test(`same provider event id cannot cross-pair principals (${order.join(" then ")})`, async () => {
      const ingressRegistry = new SlackIngressRegistry();
      const { adapter, channel, bindCalls, actors } = harness({
        ingressRegistry,
      });
      await channel.ɵruntime.start();
      const turns = {
        U1: turn("E-collision", "first", {
          actorId: "U1",
          conversationId: "C1",
          conversationKey: "opaque-conversation-c1",
          canonicalThreadId: "opaque-canonical-c1",
          providerThreadId: "provider-thread-c1",
          logicalMessageId: "M1",
        }),
        U2: turn("E-collision", "second", {
          actorId: "U2",
          conversationId: "C2",
          conversationKey: "opaque-conversation-c2",
          canonicalThreadId: "opaque-canonical-c2",
          providerThreadId: "provider-thread-c2",
          logicalMessageId: "M2",
        }),
      };

      await Promise.all(
        order.map((actorId) => adapter.getSink().onTurn(turns[actorId])),
      );

      expect(new Set(actors)).toEqual(new Set(["u1", "u2"]));
      expect(bindCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channelsThreadId: "opaque-conversation-c1",
            providerConversationId: "C1",
            createdByUserId: "u1",
          }),
          expect.objectContaining({
            channelsThreadId: "opaque-conversation-c2",
            providerConversationId: "C2",
            createdByUserId: "u2",
          }),
        ]),
      );
    });
  }

  test("a provider/canonical principal mismatch fails before subscription, binding, or run", async () => {
    const identityLinker: OpenBotSlackChannelDependencies["identityLinker"] = {
      async resolve(context) {
        return {
          kind: "linked",
          user: { id: "victim", name: "Victim" },
          actor: { id: "victim", role: "user" },
          identity: {
            provider: "slack",
            providerTenantId: context.tenant.id,
            providerUserId: "DIFFERENT-SLACK-ACTOR",
            providerEmail: null,
          },
        };
      },
    };
    const { adapter, channel, bindCalls, events, shared } = harness({
      identityLinker,
    });
    await channel.ɵruntime.start();

    await expect(
      adapter.getSink().onTurn(turn("E-mismatch", "start")),
    ).rejects.toThrow("identity is no longer available");
    await adapter
      .getSink()
      .onTurn(turn("E-after", "follow up", { mentioned: false }));

    expect(bindCalls).toEqual([]);
    expect(shared.inputs).toEqual([]);
    expect(adapter.posted).toEqual([]);
    expect(events).toEqual([
      { type: "slack-turn-failed", phase: "identity.validate" },
    ]);
  });

  test("passes multimodal content parts and serializes overlapping thread turns", async () => {
    const { adapter, channel, shared } = harness();
    await channel.ɵruntime.start();
    shared.blockRuns = true;
    const first = adapter.getSink().onTurn({
      ...turn("E1", "start"),
      contentParts: [{ type: "text" as const, text: "from a content part" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = adapter
      .getSink()
      .onTurn(turn("E2", "follow up", { mentioned: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shared.inputs).toHaveLength(1);
    expect(shared.inputs[0]?.messages.at(-1)?.content).toEqual([
      { type: "text", text: "from a content part" },
    ]);
    expect(shared.maxActive).toBe(1);
    shared.blockRuns = false;
    shared.pendingFinishes.shift()?.();
    await Promise.all([first, second]);
    expect(shared.inputs).toHaveLength(2);
    expect(shared.maxActive).toBe(1);
  });

  test("exposes governed computer tools, file sharing, and approvals to the delegated run", async () => {
    // No handler is invoked in this registration test; Task 9 exercises each operation against a
    // full fake gateway, including successful/truncated/refused file uploads.
    const computerGateway = {} as ComputerGateway;
    const { adapter, channel, shared } = harness({ computerGateway });
    await channel.ɵruntime.start();
    await adapter.getSink().onTurn(turn("E-tools", "start"));

    const names = shared.inputs[0]?.tools.map(({ name }) => name);
    expect(names).toContain("computer_navigate");
    expect(names).toContain("computer_share_file");
    expect(names).toContain("approval_card");
  });

  test("executes UTF-8 file sharing through the managed channel", async () => {
    const gateway = new ShareComputerGateway();
    const { adapter, channel, shared, filePosts } = harness({
      computerGateway: gateway,
    });
    shared.toolCall = {
      name: "computer_share_file",
      args: { path: "reports/risk.txt", filename: "résumé.txt" },
    };
    await channel.ɵruntime.start();
    await adapter.getSink().onTurn(turn("E-share", "share the report"));

    expect(gateway.readFileCalls).toEqual([
      ["risk", { id: "u1", userId: "u1" }, { path: "reports/risk.txt" }],
    ]);
    expect(filePosts).toHaveLength(1);
    expect(filePosts[0]?.[1]).toEqual({
      bytes: new TextEncoder().encode("Résumé 📊"),
      filename: "résumé.txt",
    });
    expect(toolResult(shared)).toMatchObject({
      ok: true,
      shared: true,
      filename: "résumé.txt",
      fileId: "F1",
    });
  });

  test("a cached agent uses the current Slack execution for a later computer tool", async () => {
    const gateway = new ShareComputerGateway();
    const { adapter, channel, shared } = harness({
      computerGateway: gateway,
      cacheAgents: true,
      detachThreadOperations: true,
    });
    await channel.ɵruntime.start();

    await adapter.getSink().onTurn(turn("E-first", "hello"));
    shared.toolCall = {
      name: "computer_navigate",
      args: { url: "https://copilotkit.ai" },
    };
    await adapter.getSink().onTurn(
      turn("E-second", "open it", {
        actorId: "U2",
        mentioned: false,
      }),
    );

    expect(gateway.navigateCalls).toEqual([
      ["risk", { id: "u2", userId: "u2" }, "https://copilotkit.ai"],
    ]);
    expect(toolResult(shared)).toMatchObject({
      ok: true,
      url: "https://copilotkit.ai",
    });
  });

  test("refuses truncated and adapter-rejected file shares explicitly", async () => {
    const truncated = new ShareComputerGateway();
    truncated.readFileResult = {
      path: "large.txt",
      text: "partial",
      truncated: true,
      bytes: 999,
    };
    const first = harness({ computerGateway: truncated });
    first.shared.toolCall = {
      name: "computer_share_file",
      args: { path: "large.txt" },
    };
    await first.channel.ɵruntime.start();
    await first.adapter.getSink().onTurn(turn("E-large", "share it"));
    expect(first.filePosts).toEqual([]);
    expect(toolResult(first.shared)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("too large"),
    });

    const refused = new ShareComputerGateway();
    const second = harness({
      computerGateway: refused,
      postFileResult: { ok: false, error: "Slack rejected this file type." },
    });
    second.shared.toolCall = {
      name: "computer_share_file",
      args: { path: "reports/risk.txt" },
    };
    await second.channel.ɵruntime.start();
    await second.adapter.getSink().onTurn(turn("E-refused", "share it"));
    expect(second.filePosts).toHaveLength(1);
    expect(toolResult(second.shared)).toEqual({
      ok: false,
      reason: "Slack rejected this file type.",
    });
  });

  test("shared actor resolver carries managed inputs and current grants to built-in and remote coworkers", async () => {
    const role = "You are the same standing risk coworker in every channel.";
    const grantActors: string[] = [];
    const signed: string[] = [];
    const grantedFor = (actorId: string) => async () => {
      grantActors.push(actorId);
      return [
        {
          name: "mcp__risk__lookup",
          description: "Look up a risk record.",
          parameters: z.object({ recordId: z.string() }),
          ref: "risk/lookup",
          execute: async () => actorId,
        },
      ];
    };
    const llm = new LLMock();
    const priorBase = process.env.OPENAI_BASE_URL;
    const priorKey = process.env.OPENAI_API_KEY;
    const baseUrl = await llm.start();
    process.env.OPENAI_BASE_URL = baseUrl;
    process.env.OPENAI_API_KEY = "managed-channel-test-key";
    llm.onMessage(/.*/, { type: "text", content: "built-in complete" });

    try {
      const builtResolver = createActorAgentResolver({
        loadAgents: async () => [
          {
            id: "analyst",
            name: "Analyst",
            type: "built_in" as const,
            systemPrompt: role,
          },
        ],
        model: { provider: "openai", defaultModel: "gpt-5.5" },
        resolveModelApiKey: async () => "managed-channel-test-key",
        loadToolsForActor: grantedFor,
        signRunForActor: (actorId) => (botId, runId) => {
          const assertion = `signed:${actorId}:${botId}:${runId}`;
          signed.push(assertion);
          return assertion;
        },
      });
      const originalBuilt = await builtResolver.resolveAgentForActor(
        { id: "u1", role: "user" },
        "analyst",
      );
      const clonedBuilt = originalBuilt.clone() as AbstractAgent;
      expect(clonedBuilt).toBeInstanceOf(BuiltInAgent);
      expect(Object.getPrototypeOf(clonedBuilt)).toBe(
        Object.getPrototypeOf(originalBuilt),
      );
      const clonedResolver: ActorAgentResolver = {
        async resolveAgentsForActor() {
          return { analyst: clonedBuilt };
        },
        async resolveAgentForActor(actor, agentId) {
          expect(actor.id).toBe("u1");
          expect(agentId).toBe("analyst");
          return clonedBuilt;
        },
      };
      const built = harness({ resolver: clonedResolver, agentId: "analyst" });
      await built.channel.ɵruntime.start();
      await built.adapter.getSink().onTurn({
        ...turn("E-built", "ignored fallback"),
        contentParts: [{ type: "text", text: "inspect built-in content" }],
      });
      await built.channel.ɵruntime.stop();

      const builtRequest = llm.getRequests().at(-1)?.body as {
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      expect(
        builtRequest.messages?.some(
          ({ role: messageRole, content }) =>
            messageRole === "system" && String(content).includes(role),
        ),
      ).toBe(true);
      expect(JSON.stringify(builtRequest.messages)).toContain(
        "inspect built-in content",
      );
      const builtTools = (builtRequest.tools ?? []).map(
        (tool) => tool.function?.name,
      );
      expect(builtTools).toContain("mcp__risk__lookup");
      expect(builtTools).toContain("approval_card");
      expect(JSON.stringify(builtRequest)).not.toContain("signed:u1:analyst:");
      expect(JSON.stringify(builtRequest)).not.toContain("providerTenantId");

      const remoteInputs: RunAgentInput[] = [];
      const remoteResolver = createActorAgentResolver({
        loadAgents: async () => [
          {
            id: "risk",
            name: "Risk",
            type: "remote_ag_ui" as const,
            endpoint: "https://risk.example/ag-ui",
            standingMessage: {
              id: "standing-role:risk",
              role: "system" as const,
              content: role,
            },
          },
        ],
        model: { provider: "openai", defaultModel: "gpt-5.5" },
        resolveModelApiKey: async () => null,
        loadToolsForActor: grantedFor,
        signRunForActor: (actorId) => (botId, runId) => {
          const assertion = `signed:${actorId}:${botId}:${runId}`;
          signed.push(assertion);
          return assertion;
        },
        agentFetch: async (_input, init) => {
          const sent = JSON.parse(String(init?.body)) as RunAgentInput;
          remoteInputs.push(sent);
          return new Response(
            [
              {
                type: "RUN_STARTED",
                threadId: sent.threadId,
                runId: sent.runId,
              },
              {
                type: "RUN_FINISHED",
                threadId: sent.threadId,
                runId: sent.runId,
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const remote = harness({ resolver: remoteResolver, agentId: "risk" });
      await remote.channel.ɵruntime.start();
      await remote.adapter.getSink().onTurn({
        ...turn("E-remote", "ignored fallback"),
        contentParts: [{ type: "text", text: "inspect remote content" }],
      });
      await remote.channel.ɵruntime.stop();

      const sent = remoteInputs[0];
      expect(sent?.messages[0]).toMatchObject({
        role: "system",
        content: role,
      });
      expect(JSON.stringify(sent?.messages)).toContain(
        "inspect remote content",
      );
      expect(sent?.tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["approval_card", "mcp__risk__lookup"]),
      );
      expect(sent?.forwardedProps).toMatchObject({
        openbotBotId: "risk",
        openbotDeploymentTools: ["mcp__risk__lookup"],
        openbotRun: expect.stringContaining("signed:u1:risk:"),
      });
      expect(grantActors).toEqual(["u1", "u1"]);
      expect(signed).toEqual([
        expect.stringContaining("signed:u1:analyst:"),
        expect.stringContaining("signed:u1:risk:"),
      ]);
      for (const input of [sent]) {
        expect(JSON.stringify(input)).not.toContain("providerTenantId");
        expect(JSON.stringify(input)).not.toContain("channelsConversationKey");
      }
    } finally {
      await llm.stop();
      if (priorBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = priorBase;
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
    }
  });

  test("an authorized approval interaction resumes the pinned agent as the current participant", async () => {
    const presentations = new Map<string, ApprovalPresentation>();
    configureApprovalDecisionStore(
      {
        async present(value) {
          presentations.set(value.presentationId, {
            ...value,
            createdAt: new Date(),
          });
        },
        async get(id) {
          return presentations.get(id) ?? null;
        },
        async begin() {
          return "first";
        },
        async complete() {},
        async cleanup() {
          return 0;
        },
      },
      {
        authorize: async ({ userId }) => ({
          actor: { id: userId, role: "user" },
          applicationUser: { id: userId, name: userId },
          provider: "slack",
          providerTenantId: "T1",
          providerConversationId: "C1",
          providerThreadId: "provider-thread-1",
        }),
      },
    );
    const { adapter, channel, shared, actors } = harness();
    shared.requestApproval = true;
    await channel.ɵruntime.start();
    await adapter.getSink().onTurn(turn("E-approval", "deploy"));
    expect(shared.inputs).toHaveLength(2);
    const approve = adapter.posted.flat().flatMap(actionIds)[0];
    expect(approve).toBeDefined();

    await adapter.getSink().onInteraction({
      id: approve!,
      conversationKey: "opaque-conversation-C1",
      replyTarget: { canonicalThreadId: "canonical-thread-1" },
      eventId: "E-click",
      actor: { id: "U2", kind: "human", name: "U2" },
      identityContext: interactionIdentity("E-click", "U2"),
    });

    expect(actors.at(-1)).toBe("u2");
    expect(shared.inputs.at(-1)?.forwardedProps?.command).toEqual({
      resume: { approved: true },
    });
  });

  test("cold approval recovery reauthorizes the current participant and reconstructs private execution", async () => {
    const state = new MemoryStore();
    const presentations = new Map<string, ApprovalPresentation>();
    let active = true;
    let accessible = true;
    const bindings = new Map<string, ExternalThreadBinding>();
    const authorizationBinding: ExternalThreadBinding = {
      channelsThreadId: "opaque-conversation-C1",
      provider: "slack",
      providerTenantId: "T1",
      providerConversationId: "C1",
      providerThreadId: "provider-thread-1",
      agentId: "risk",
      agentName: "Risk Analyst",
      createdByUserId: "u1",
      createdAt: new Date("2026-08-27T00:00:00.000Z"),
    };
    bindings.set(authorizationBinding.channelsThreadId, authorizationBinding);
    const authorizer = createApprovalAuthorizer({
      links: {
        async find() {
          return null;
        },
        async findVerifiedUserByEmail() {
          return null;
        },
        async link() {
          throw new Error("unused");
        },
        async resolveActiveUser(id) {
          return active ? { id, name: `Current ${id}`, role: "user" } : null;
        },
      },
      threads: {
        async getByChannelsThreadId(id) {
          return bindings.get(id) ?? null;
        },
        async getByProviderThread() {
          return null;
        },
        async bind() {
          throw new Error("unused");
        },
      },
      profiles: {
        async get() {
          return accessible ? ({} as never) : null;
        },
      },
    });
    configureApprovalDecisionStore(
      {
        async present(value) {
          presentations.set(value.presentationId, {
            ...value,
            createdAt: new Date(),
          });
        },
        async get(id) {
          return presentations.get(id) ?? null;
        },
        async begin() {
          return "first";
        },
        async complete() {},
        async cleanup() {
          return 0;
        },
      },
      { authorize: authorizer },
    );
    const identityLinker: OpenBotSlackChannelDependencies["identityLinker"] = {
      async resolve(context) {
        if (context.actor.id === "UNLINKED") {
          return {
            kind: "unlinked",
            linkUrl: "https://openbot.test/link/slack?token=opaque",
            identity: {
              provider: "slack",
              providerTenantId: context.tenant.id,
              providerUserId: context.actor.id,
              providerEmail: null,
            },
          };
        }
        const applicationUserId = context.actor.id.startsWith("U2")
          ? "u2"
          : context.actor.id.toLowerCase();
        return {
          kind: "linked",
          user: {
            id: applicationUserId,
            name: context.actor.id,
          },
          actor: { id: applicationUserId, role: "user" },
          identity: {
            provider: "slack",
            providerTenantId: context.tenant.id,
            providerUserId:
              context.actor.id === "U2-FOREIGN" ? "U2" : context.actor.id,
            providerEmail: null,
          },
        };
      },
    };

    const first = harness({ stateStore: state, bindings, identityLinker });
    first.shared.requestApproval = true;
    await first.channel.ɵruntime.start();
    await first.adapter.getSink().onTurn(turn("E-cold", "deploy"));
    const approve = first.adapter.posted.flat().flatMap(actionIds)[0];
    expect(approve).toBeDefined();
    const providerAction = first.adapter.posted
      .flat()
      .find((node) => actionIds(node).includes(approve!));
    expect(JSON.stringify(providerAction)).not.toContain("providerTenantId");
    expect(JSON.stringify(providerAction)).not.toContain("channelsThreadId");
    await first.channel.ɵruntime.stop();

    const restarted = harness({
      stateStore: state,
      shared: first.shared,
      bindings,
      identityLinker,
    });
    await restarted.channel.ɵruntime.start();
    const click = (
      eventId: string,
      actorId: string,
      overrides: Partial<InteractionEvent> = {},
    ) =>
      restarted.adapter.getSink().onInteraction({
        id: approve!,
        value: {
          approved: false,
          providerTenantId: "provider-tampered",
          channelsThreadId: "provider-tampered",
        },
        conversationKey: "opaque-conversation-C1",
        replyTarget: { canonicalThreadId: "canonical-thread-1" },
        eventId,
        actor: { id: actorId, kind: "human", name: actorId },
        identityContext: interactionIdentity(eventId, actorId),
        ...overrides,
      });

    await expect(
      click("E-wrong-conversation", "U2", {
        conversationKey: "opaque-foreign-conversation",
      }),
    ).rejects.toThrow("authorized");
    await expect(
      click("E-wrong-tenant", "U2", {
        identityContext: {
          ...interactionIdentity("E-wrong-tenant", "U2"),
          tenant: { id: "T2" },
        },
      }),
    ).rejects.toThrow("authorized");
    await expect(
      click("E-wrong-provider-conversation", "U2", {
        identityContext: interactionIdentity(
          "E-wrong-provider-conversation",
          "U2",
          "T1",
          "C9",
        ),
      }),
    ).rejects.toThrow("authorized");
    await expect(
      click("E-wrong-provider-thread", "U2", {
        identityContext: interactionIdentity(
          "E-wrong-provider-thread",
          "U2",
          "T1",
          "C1",
          "provider-thread-foreign",
        ),
      }),
    ).rejects.toThrow("authorized");
    await expect(
      click("E-wrong-provider-actor", "U2-FOREIGN", {
        identityContext: interactionIdentity(
          "E-wrong-provider-actor",
          "U2-FOREIGN",
          "T1",
          "C1",
        ),
      }),
    ).rejects.toThrow("authorized");
    await expect(click("E-unlinked-click", "UNLINKED")).rejects.toThrow(
      "authorized",
    );
    active = false;
    await expect(click("E-revoked", "U2")).rejects.toThrow("authorized");
    active = true;
    accessible = false;
    await expect(click("E-no-access", "U2")).rejects.toThrow("authorized");
    accessible = true;

    await click("E-authorized", "U2");
    expect(restarted.actors.at(-1)).toBe("u2");
    expect(restarted.shared.inputs.at(-1)?.forwardedProps?.command).toEqual({
      resume: { approved: true },
    });
    await restarted.channel.ɵruntime.stop();
  });
});
