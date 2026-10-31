import { describe, expect, test } from "bun:test";
import {
  addressedTo,
  CONNECT_APP_MARKER,
  connectAppRefusal,
  readConnectPrompt,
} from "./connect-prompt";

describe("a refusal asking somebody to connect an app", () => {
  test("survives the round trip", () => {
    const text = connectAppRefusal({
      serverId: "srv_notion",
      title: "Notion",
      message: "You have not connected your Notion account.",
    });

    expect(readConnectPrompt(text)).toEqual({
      serverId: "srv_notion",
      title: "Notion",
      message: "You have not connected your Notion account.",
    });
  });

  test("keeps the sentence readable for anything that cannot parse it", () => {
    const text = connectAppRefusal({
      serverId: "srv_notion",
      title: "Notion",
      message: "You have not connected your Notion account.",
    });

    // The model is told this string. Whatever the marker does, the English has to survive.
    expect(text.endsWith("You have not connected your Notion account.")).toBe(
      true,
    );
    expect(text.startsWith(CONNECT_APP_MARKER)).toBe(true);
  });
});

describe("text that is not one", () => {
  test.each([
    ["an ordinary refusal", "That tool is not granted."],
    ["nothing at all", ""],
    ["a truncated marker", `${CONNECT_APP_MARKER}{"serverId":"srv"`],
    ["JSON that is not an object", `${CONNECT_APP_MARKER}"srv"} hello`],
    ["a missing title", `${CONNECT_APP_MARKER}{"serverId":"srv"} hello`],
    [
      "a title of the wrong type",
      `${CONNECT_APP_MARKER}{"serverId":"srv","title":7} hello`,
    ],
    [
      "an empty server id",
      `${CONNECT_APP_MARKER}{"serverId":"","title":"Notion"} hello`,
    ],
  ])("reads as no prompt: %s", (_what, text) => {
    expect(readConnectPrompt(text)).toBeNull();
  });

  test("undefined reads as no prompt", () => {
    expect(readConnectPrompt(undefined)).toBeNull();
  });
});

describe("the Bot, the reason and the moment it carries", () => {
  test("survive the round trip, and are left out when absent", () => {
    const text = connectAppRefusal({
      serverId: "composio-gmail",
      title: "Gmail",
      message: "Your Gmail account is no longer connected at the vendor.",
      agentId: "expenses",
      reason: "reconnect",
      at: "2026-10-20T12:00:00.000Z",
      blocked: true,
    });
    expect(readConnectPrompt(text)).toEqual({
      serverId: "composio-gmail",
      title: "Gmail",
      message: "Your Gmail account is no longer connected at the vendor.",
      agentId: "expenses",
      reason: "reconnect",
      at: "2026-10-20T12:00:00.000Z",
      blocked: true,
    });
    expect(connectAppRefusal({ serverId: "s", title: "T", message: "m" })).toBe(
      `${CONNECT_APP_MARKER}{"serverId":"s","title":"T"} m`,
    );
  });

  test("a field of the wrong shape is dropped, and the prompt still names its app", () => {
    const prompt = readConnectPrompt(
      `${CONNECT_APP_MARKER}{"serverId":"composio-gmail","title":"Gmail","agentId":7,"reason":"grant me","at":"yesterday","blocked":"yes"} hello`,
    );
    expect(prompt).toEqual({
      serverId: "composio-gmail",
      title: "Gmail",
      message: "hello",
    });
  });

  test("addressedTo names the Bot on a prompt that names none, and leaves everything else alone", () => {
    const bare = connectAppRefusal({
      serverId: "notion",
      title: "Notion",
      message: "You have not connected your Notion account.",
      reason: "shared",
    });
    expect(readConnectPrompt(addressedTo(bare, "expenses"))).toEqual({
      serverId: "notion",
      title: "Notion",
      message: "You have not connected your Notion account.",
      reason: "shared",
      agentId: "expenses",
    });

    const named = connectAppRefusal({
      serverId: "notion",
      title: "Notion",
      message: "m",
      agentId: "travel",
    });
    expect(addressedTo(named, "expenses")).toBe(named);
    expect(addressedTo("That tool is not granted.", "expenses")).toBe(
      "That tool is not granted.",
    );
  });
});
