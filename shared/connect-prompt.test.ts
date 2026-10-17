import { describe, expect, test } from "bun:test";
import {
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
