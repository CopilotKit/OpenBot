import { describe, expect, test } from "bun:test";
import { frameFiring } from "@openbot/shared/routine-firing";
import type { VisibleChatItem } from "../src/components/channels/chat-messages";
import { latestFrom } from "../src/components/channels/chat-transcript";

/**
 * Which rows of a transcript are still the latest thing, the gate an app card passes before it
 * carries its task on by itself (see `lib/copilot/carry-on.ts`). A row is latest only while nothing
 * has been said to the Bot since it, nothing is queued, and the Bot is not working.
 */

const said = (id: string, text = "find my invoices"): VisibleChatItem => ({
  kind: "text",
  id,
  role: "user",
  text,
});
const answered = (id: string): VisibleChatItem => ({
  kind: "text",
  id,
  role: "assistant",
  text: "Gmail isn't connected yet.",
});
const card = (id: string): VisibleChatItem => ({
  kind: "tool",
  id,
  toolCall: {
    id,
    type: "function",
    function: { name: "show_app_access", arguments: "{}" },
  },
  result: "{}",
});
const idle = { busy: false, queued: 0 };

describe("latestFrom", () => {
  test("a card and the Bot's words after it are latest once the Bot is idle", () => {
    const items = [said("u1"), card("c1"), answered("a1")];
    expect(latestFrom(items, idle)).toBe(1);
  });

  test("a card the person has spoken after is not", () => {
    const items = [said("u1"), card("c1"), answered("a1"), said("u2")];
    expect(latestFrom(items, idle)).toBe(items.length);
  });

  test("a file sent with no caption moves the conversation on too", () => {
    const items: VisibleChatItem[] = [
      said("u1"),
      card("c1"),
      { kind: "attachments", id: "u2:attachments", attachments: [] },
    ];
    expect(latestFrom(items, idle)).toBe(items.length);
  });

  test("a routine firing after the card moves it on, though nobody typed it", () => {
    const items = [
      said("u1"),
      card("c1"),
      said("f1", frameFiring("Summarise the support queue.")),
      answered("a2"),
    ];
    expect(latestFrom(items, idle)).toBe(3);
  });

  test("nothing is latest while the Bot works or a message waits", () => {
    const items = [said("u1"), card("c1")];
    expect(latestFrom(items, { busy: true, queued: 0 })).toBe(items.length);
    expect(latestFrom(items, { busy: false, queued: 1 })).toBe(items.length);
  });

  test("a conversation the Bot started has every row latest", () => {
    expect(latestFrom([card("c1")], idle)).toBe(0);
  });
});
