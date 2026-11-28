/** Thin Telegram Bot API helpers used by the channel front. */

export type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number; is_bot?: boolean };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type TelegramApi = {
  getMe(): Promise<{ id: number; username: string }>;
  sendMessage(chatId: string, text: string): Promise<{ id: string }>;
  setWebhook(url: string, secretToken: string): Promise<void>;
};

export function createTelegramApi(input: {
  token: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): TelegramApi {
  const wire = input.fetch ?? fetch;
  const base = `https://api.telegram.org/bot${input.token}`;
  async function call<T>(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const response = await wire(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      description?: string;
      result?: T;
    };
    if (!response.ok || payload.ok !== true || payload.result === undefined) {
      throw new Error(
        payload.description ?? `Telegram ${method} failed (${response.status})`,
      );
    }
    return payload.result;
  }
  return {
    async getMe() {
      const me = await call<{ id: number; username: string }>("getMe");
      if (!me.username) throw new Error("Telegram bot has no username.");
      return me;
    },
    async sendMessage(chatId, text) {
      const sent = await call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: text.slice(0, 4096),
      });
      return { id: String(sent.message_id) };
    },
    async setWebhook(url, secretToken) {
      await call("setWebhook", {
        url,
        secret_token: secretToken,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
    },
  };
}
