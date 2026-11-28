/**
 * OpenTag-shaped Telegram front for OpenBot Reaching you.
 *
 * Env:
 * - TELEGRAM_BOT_TOKEN — BotFather token for this front (deployment-level)
 * - OPENTAG_SHARED_SECRET — same value OpenBot has as OPENTAG_SHARED_SECRET
 * - OPENBOT_AGENT_URL — OpenBot's OpenTag agent, e.g.
 *   https://openbot.example/api/delivery/webhooks/opentag/agent
 * - PUBLIC_URL — this front's public origin (for setWebhook)
 * - PORT — listen port (default 8787)
 *
 * Point OpenBot's OPENTAG_URL at this front so proactive replies land in Telegram.
 * OpenBot must accept provider `telegram` in its OpenTag sender parser before
 * inbound turns bind; see docs/channels/telegram.md.
 */

import { createAllowList } from "./allow-list";
import { linkCodeIn, runInput, textFromAgUiStream } from "./opentag";
import { createTelegramApi, type TelegramUpdate } from "./telegram";

/** Injected HTTP client; tests pass a stub without fetch.preconnect. */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ChannelConfig = {
  botToken: string;
  sharedSecret: string;
  openBotAgentUrl: string;
  publicUrl: string;
  port?: number;
  fetch?: FetchLike;
  /** Pre-seeded allow-list (tests). */
  allowList?: ReturnType<typeof createAllowList>;
};

const UNBOUND =
  "I don't know who you are in OpenBot yet, so I did not run anything. In OpenBot, open the Bot's page, choose Reaching you and the conversation, pick Connect Telegram, paste this bot's token, and send me the `link <code>` message it shows you.";

const REFUSED =
  "Only the chat that linked this bot in OpenBot can talk here. Disconnect there and connect again from the chat you want.";

function sameSecret(expected: string, presented: string | null) {
  if (!presented) return false;
  const want = `Bearer ${expected}`;
  if (want.length !== presented.trim().length) return false;
  // Constant-time-ish compare for equal-length strings.
  let diff = 0;
  const a = want;
  const b = presented.trim();
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function createChannelTelegram(config: ChannelConfig) {
  const wire = config.fetch ?? fetch;
  const telegram = createTelegramApi({
    token: config.botToken,
    fetch: wire,
  });
  const allow = config.allowList ?? createAllowList();
  let botId: string | null = null;

  async function ensureBot() {
    if (botId) return botId;
    const me = await telegram.getMe();
    botId = String(me.id);
    return botId;
  }

  async function forwardToOpenBot(input: {
    chatId: string;
    messageId: string;
    text: string;
    privateChat: boolean;
  }) {
    const id = await ensureBot();
    const response = await wire(config.openBotAgentUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.sharedSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        runInput({
          botId: id,
          chatId: input.chatId,
          messageId: input.messageId,
          text: input.text,
          privateChat: input.privateChat,
        }),
      ),
    });
    const body = await response.text();
    return { status: response.status, body, text: textFromAgUiStream(body) };
  }

  async function onTelegramUpdate(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text || message.from?.is_bot) return;
    const chatId = String(message.chat.id);
    const privateChat = message.chat.type === "private";
    const text = message.text.trim();
    if (!text) return;

    const code = linkCodeIn(text);
    if (code) {
      // Prefer a DM for linking, matching OpenBot's Slack rule.
      if (!privateChat) {
        await telegram.sendMessage(
          chatId,
          "Send that link code in a direct message with this bot, not in a group.",
        );
        return;
      }
      const result = await forwardToOpenBot({
        chatId,
        messageId: String(message.message_id),
        text,
        privateChat: true,
      });
      if (result.status >= 200 && result.status < 300) {
        allow.add(chatId);
      }
      if (result.text) await telegram.sendMessage(chatId, result.text);
      else if (result.status === 401)
        await telegram.sendMessage(
          chatId,
          "OpenBot refused this channel's credentials. Check OPENTAG_SHARED_SECRET.",
        );
      else
        await telegram.sendMessage(
          chatId,
          result.status >= 400
            ? "OpenBot could not use that code. Create a new one under Reaching you."
            : "Linked. You can talk to your Bot here.",
        );
      return;
    }

    if (!allow.has(chatId)) {
      await telegram.sendMessage(
        chatId,
        allow.size() === 0 ? UNBOUND : REFUSED,
      );
      return;
    }

    const result = await forwardToOpenBot({
      chatId,
      messageId: String(message.message_id),
      text,
      privateChat,
    });
    if (result.text) await telegram.sendMessage(chatId, result.text);
    else if (result.status >= 400)
      await telegram.sendMessage(
        chatId,
        "OpenBot could not answer just now. Try again in a moment.",
      );
  }

  async function onDeliver(request: Request): Promise<Response> {
    if (!sameSecret(config.sharedSecret, request.headers.get("authorization")))
      return Response.json(
        { error: "Invalid OpenTag credentials." },
        { status: 401 },
      );
    let body: {
      id?: unknown;
      platform?: unknown;
      address?: unknown;
      text?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json(
        { error: "Supply a valid request." },
        { status: 400 },
      );
    }
    if (
      typeof body.address !== "string" ||
      typeof body.text !== "string" ||
      typeof body.id !== "string"
    )
      return Response.json(
        { error: "Supply a valid request." },
        { status: 400 },
      );
    if (!allow.has(body.address))
      return Response.json(
        { error: "That Telegram chat is not allow-listed." },
        { status: 404 },
      );
    const sent = await telegram.sendMessage(body.address, body.text);
    return Response.json({
      ok: true,
      id: sent.id,
      channel: body.address,
    });
  }

  async function onWebhook(request: Request): Promise<Response> {
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    if (secret !== config.sharedSecret.slice(0, 256))
      return Response.json(
        { error: "Invalid Telegram secret." },
        { status: 401 },
      );
    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return Response.json(
        { error: "Supply a valid request." },
        { status: 400 },
      );
    }
    // Answer Telegram quickly; work continues on this promise.
    void onTelegramUpdate(update).catch((error) => {
      console.error(
        JSON.stringify({
          type: "channel-telegram-update-error",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    });
    return new Response("ok");
  }

  return {
    allow,
    ensureBot,
    onDeliver,
    onWebhook,
    onTelegramUpdate,
    async listen() {
      await ensureBot();
      const webhook = new URL("/telegram/webhook", config.publicUrl).toString();
      await telegram.setWebhook(webhook, config.sharedSecret.slice(0, 256));
      const port = config.port ?? 8787;
      return Bun.serve({
        port,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (request.method === "POST" && path === "/openbot/deliver")
            return onDeliver(request);
          if (request.method === "POST" && path === "/telegram/webhook")
            return onWebhook(request);
          if (request.method === "GET" && path === "/health")
            return Response.json({ ok: true, allowListed: allow.size() });
          return new Response("Not found", { status: 404 });
        },
      });
    },
  };
}
