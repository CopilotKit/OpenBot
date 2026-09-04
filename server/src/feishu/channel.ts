import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { lastValueFrom } from "rxjs";
import { toArray } from "rxjs/operators";
import {
  OpenBotChannelAgent,
  type OpenBotChannelAgentDependencies,
} from "../slack/channel-agent";
import { runWithSlackExecution } from "../slack/execution-context";
import type { FeishuMessage, FeishuTransport } from "./transport";

export type FeishuResolvedUser =
  | {
      kind: "linked";
      actor: { id: string; role: "admin" | "user" };
      user: { id: string; name: string };
    }
  | { kind: "unlinked"; linkUrl: string };

export type OpenBotFeishuChannelDependencies = {
  transport: FeishuTransport;
  agentDeps: OpenBotChannelAgentDependencies;
  resolveUser(identity: {
    provider: "feishu";
    providerTenantId: string;
    providerUserId: string;
  }): Promise<FeishuResolvedUser | null>;
};

function assistantText(events: readonly BaseEvent[]): string {
  return events
    .filter(
      (event): event is BaseEvent & { delta: string } =>
        "delta" in event &&
        (event.type === "TEXT_MESSAGE_CONTENT" ||
          event.type === "TEXT_MESSAGE_CHUNK") &&
        typeof event.delta === "string",
    )
    .map((event) => event.delta)
    .join("");
}

export function createOpenBotFeishuChannel({
  transport,
  agentDeps,
  resolveUser,
}: OpenBotFeishuChannelDependencies) {
  let started = false;

  async function handleMessage(message: FeishuMessage): Promise<void> {
    if (message.chatType === "group" && !message.mentionedBot) return;
    const resolved = await resolveUser({
      provider: "feishu",
      providerTenantId: transport.tenantKey,
      providerUserId: message.senderId,
    });
    if (!resolved) return;
    if (resolved.kind === "unlinked") {
      await transport.send(
        message.chatId,
        `请先关联 OpenBot 账户：[打开关联页面](${resolved.linkUrl})`,
        { replyTo: message.messageId },
      );
      return;
    }

    const providerThreadId =
      message.threadId ??
      message.rootId ??
      message.replyToMessageId ??
      message.messageId;
    const conversationKey = `feishu:${transport.tenantKey}:${message.chatId}:${providerThreadId}`;
    const execution = {
      actor: resolved.actor,
      applicationUser: resolved.user,
      provider: "feishu" as const,
      providerTenantId: transport.tenantKey,
      providerConversationId: message.chatId,
      providerThreadId,
      messageText: message.content,
    };
    const agent = new OpenBotChannelAgent(
      conversationKey,
      agentDeps,
      execution,
    );
    const input: RunAgentInput = {
      threadId: conversationKey,
      runId: crypto.randomUUID(),
      state: {},
      messages: [
        { id: message.messageId, role: "user", content: message.content },
      ],
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const events = await runWithSlackExecution(execution, () =>
      lastValueFrom(agent.run(input).pipe(toArray())),
    );
    const reply = assistantText(events);
    if (reply) {
      await transport.send(message.chatId, reply, {
        replyTo: message.messageId,
      });
    }
  }

  return {
    async start() {
      if (started) return;
      transport.onMessage(handleMessage);
      await transport.connect();
      started = true;
    },
    async stop() {
      if (!started) return;
      started = false;
      await transport.disconnect();
    },
  };
}
