import { describe, expect, test } from "bun:test";
import { createAllowList } from "./allow-list";
import { createChannelTelegram } from "./server";

describe("channel-telegram deliver", () => {
  test("refuses a missing bearer", async () => {
    const channel = createChannelTelegram({
      botToken: "1:token",
      sharedSecret: "s".repeat(32),
      openBotAgentUrl: "https://openbot.example/agent",
      publicUrl: "https://telegram.example",
      allowList: createAllowList(["42"]),
      fetch: async () => new Response("unused"),
    });
    const response = await channel.onDeliver(
      new Request("https://telegram.example/openbot/deliver", {
        method: "POST",
        body: JSON.stringify({
          id: "d1",
          platform: "telegram",
          address: "42",
          text: "hi",
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("posts to an allow-listed chat", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const channel = createChannelTelegram({
      botToken: "1:token",
      sharedSecret: "s".repeat(32),
      openBotAgentUrl: "https://openbot.example/agent",
      publicUrl: "https://telegram.example",
      allowList: createAllowList(["42"]),
      fetch: async (input, init) => {
        const url = String(input);
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        calls.push({ url, body });
        if (url.includes("sendMessage"))
          return Response.json({ ok: true, result: { message_id: 9 } });
        return Response.json({ ok: true, result: {} });
      },
    });
    const response = await channel.onDeliver(
      new Request("https://telegram.example/openbot/deliver", {
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(32)}` },
        body: JSON.stringify({
          id: "d1",
          platform: "telegram",
          address: "42",
          text: "hello from OpenBot",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      id: "9",
      channel: "42",
    });
    expect(calls.some((call) => call.url.includes("sendMessage"))).toBe(true);
  });

  test("refuses a chat that was never allow-listed", async () => {
    const channel = createChannelTelegram({
      botToken: "1:token",
      sharedSecret: "s".repeat(32),
      openBotAgentUrl: "https://openbot.example/agent",
      publicUrl: "https://telegram.example",
      allowList: createAllowList(),
      fetch: async () => new Response("unused"),
    });
    const response = await channel.onDeliver(
      new Request("https://telegram.example/openbot/deliver", {
        method: "POST",
        headers: { authorization: `Bearer ${"s".repeat(32)}` },
        body: JSON.stringify({
          id: "d1",
          platform: "telegram",
          address: "99",
          text: "nope",
        }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
