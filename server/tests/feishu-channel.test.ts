import { describe, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { of } from "rxjs";
import type { ActorAgentResolver } from "../src/agents/agent-resolver";
import type { ExternalThreadStore } from "../src/external/thread-store";
import type { CoworkerRoutingService } from "../src/routing/service";
import { createOpenBotFeishuChannel } from "../src/feishu/channel";
import type { FeishuTransport } from "../src/feishu/transport";

class ReplyAgent extends AbstractAgent {
  run(_input: RunAgentInput) {
    return of(
      {
        type: "TEXT_MESSAGE_START",
        messageId: "reply-1",
        role: "assistant",
      } as BaseEvent,
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "reply-1",
        delta: "风险已审阅",
      } as BaseEvent,
      { type: "TEXT_MESSAGE_END", messageId: "reply-1" } as BaseEvent,
      {
        type: "RUN_FINISHED",
        threadId: "thread-1",
        runId: "run-1",
      } as BaseEvent,
    );
  }
}

function harness() {
  const sent: Array<{ chatId: string; markdown: string; replyTo?: string }> =
    [];
  let onMessage:
    | ((
        message: Parameters<Parameters<FeishuTransport["onMessage"]>[0]>[0],
      ) => Promise<void>)
    | undefined;
  const transport: FeishuTransport = {
    tenantKey: "tenant-key",
    onMessage(handler) {
      onMessage = handler;
    },
    async connect() {},
    async disconnect() {},
    async send(chatId, markdown, options) {
      sent.push({ chatId, markdown, replyTo: options?.replyTo });
      return { messageId: `sent-${sent.length}` };
    },
  };
  const store = {
    async getByChannelsThreadId() {
      return null;
    },
    async getByProviderThread() {
      return null;
    },
    async bind(input: Parameters<ExternalThreadStore["bind"]>[0]) {
      return { ...input, createdAt: new Date() };
    },
    async appendTranscriptTurn() {},
  } as unknown as ExternalThreadStore;
  const routing = {
    async route() {
      return { agentId: "risk", name: "Risk Analyst", reason: "named" };
    },
  } as unknown as CoworkerRoutingService;
  const resolver: ActorAgentResolver = {
    async resolveAgentsForActor() {
      return {};
    },
    async resolveAgentForActor() {
      return new ReplyAgent({ agentId: "risk" });
    },
  };
  const channel = createOpenBotFeishuChannel({
    transport,
    agentDeps: { store, routing, resolver },
    resolveUser: async () => ({
      kind: "linked",
      actor: { id: "alice", role: "user" },
      user: { id: "alice", name: "Alice" },
    }),
  });
  return {
    channel,
    sent,
    emit: async (message: Parameters<NonNullable<typeof onMessage>>[0]) =>
      onMessage?.(message),
  };
}

describe("Feishu external channel", () => {
  test("routes a direct message through the shared actor-scoped agent", async () => {
    const { channel, emit, sent } = harness();
    await channel.start();
    await emit({
      messageId: "om-1",
      chatId: "oc-1",
      chatType: "p2p",
      senderId: "ou-1",
      content: "请 Risk Analyst 审阅",
      mentionedBot: false,
      createTime: 1_700_000_000_000,
    });

    expect(sent).toEqual([
      { chatId: "oc-1", markdown: "风险已审阅", replyTo: "om-1" },
    ]);
    await channel.stop();
  });

  test("ignores group messages that do not mention the bot", async () => {
    const { channel, emit, sent } = harness();
    await channel.start();
    await emit({
      messageId: "om-2",
      chatId: "oc-group",
      chatType: "group",
      senderId: "ou-1",
      content: "普通群聊",
      mentionedBot: false,
      createTime: 1_700_000_000_000,
    });

    expect(sent).toEqual([]);
    await channel.stop();
  });
});
