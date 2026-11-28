/**
 * The OpenTag pairing contract this Telegram front speaks toward OpenBot.
 *
 * OpenBot's delivery agent at `/api/delivery/webhooks/opentag/agent` expects:
 * - `Authorization: Bearer <shared secret>`
 * - AG-UI RunAgentInput with one `openbot.sender` context entry
 * - user id shaped `provider:realm:identity`
 *
 * Today the published OpenBot image only accepts `slack` and `teams` as
 * provider. This front sends `telegram:<botId>:<chatId>` so a server that has
 * added Telegram to that allow-list can bind and run turns. Until then, inbound
 * calls are refused by OpenBot with an unbound / unknown-sender outcome.
 *
 * Proactive replies come the other way: OpenBot POSTs `/openbot/deliver` here
 * with the same bearer, and this front posts the text to the allow-listed chat.
 */

export const OPENTAG_SENDER_CONTEXT = "openbot.sender";

export type TelegramSender = {
  botId: string;
  chatId: string;
};

/** `telegram:<botId>:<chatId>` — the realm is the bot, the identity is the chat. */
export function channelUserId(sender: TelegramSender): string {
  return `telegram:${sender.botId}:${sender.chatId}`;
}

export function senderContext(input: {
  botId: string;
  chatId: string;
  messageId: string;
  privateChat: boolean;
}): { description: string; value: string } {
  return {
    description: OPENTAG_SENDER_CONTEXT,
    value: JSON.stringify({
      user: channelUserId({ botId: input.botId, chatId: input.chatId }),
      event: input.messageId,
      conversation: {
        id: input.chatId,
        kind: input.privateChat ? "direct" : "group",
      },
      mentioned: true,
    }),
  };
}

export type RunAgentInput = {
  threadId: string;
  runId: string;
  messages: { id: string; role: "user"; content: string }[];
  context: { description: string; value: string }[];
};

export function runInput(input: {
  chatId: string;
  messageId: string;
  text: string;
  botId: string;
  privateChat: boolean;
}): RunAgentInput {
  return {
    threadId: `telegram:${input.botId}:${input.chatId}`,
    runId: input.messageId,
    messages: [
      {
        id: input.messageId,
        role: "user",
        content: input.text,
      },
    ],
    context: [
      senderContext({
        botId: input.botId,
        chatId: input.chatId,
        messageId: input.messageId,
        privateChat: input.privateChat,
      }),
    ],
  };
}

const LINK =
  /\blink\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/** The Reachability code inside a Telegram message, if any. */
export function linkCodeIn(text: string): string | null {
  const match = text.match(LINK);
  return match?.[1]?.toLowerCase() ?? null;
}

/** Plain text collected from an AG-UI event stream body. */
export function textFromAgUiStream(body: string): string {
  const parts: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      const event = JSON.parse(raw) as {
        type?: string;
        delta?: string;
        message?: string;
      };
      if (typeof event.delta === "string") parts.push(event.delta);
      else if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta)
        parts.push(event.delta);
      else if (typeof event.message === "string") parts.push(event.message);
    } catch {
      /* A non-JSON data line is ignored; the turn may still have yielded text. */
    }
  }
  return parts.join("").trim();
}
