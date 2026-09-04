import {
  createLarkChannel,
  type LarkChannel,
} from "@larksuiteoapi/node-sdk";

export type FeishuMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  mentionedBot: boolean;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  createTime: number;
};

export type FeishuTransport = {
  readonly tenantKey: string;
  onMessage(handler: (message: FeishuMessage) => Promise<void>): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(
    chatId: string,
    markdown: string,
    options?: { replyTo?: string },
  ): Promise<{ messageId: string }>;
};

type CreateFeishuTransportOptions = {
  appId: string;
  appSecret: string;
  tenantKey: string;
  createChannel?: typeof createLarkChannel;
};

export function createFeishuTransport({
  appId,
  appSecret,
  tenantKey,
  createChannel = createLarkChannel,
}: CreateFeishuTransportOptions): FeishuTransport {
  const channel: LarkChannel = createChannel({
    appId,
    appSecret,
    policy: { requireMention: true, dmMode: "open" },
  });

  return {
    tenantKey,
    onMessage(handler) {
      channel.on("message", handler);
    },
    async connect() {
      await channel.connect();
    },
    async disconnect() {
      await channel.disconnect();
    },
    async send(chatId, markdown, options) {
      const result = await channel.send(
        chatId,
        { markdown },
        options?.replyTo ? { replyTo: options.replyTo } : undefined,
      );
      return { messageId: result.messageId };
    },
  };
}
