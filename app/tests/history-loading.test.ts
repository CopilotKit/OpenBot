import { expect, test } from "bun:test";
import { historyIsLoading } from "@/components/channels/channel-chat";

/**
 * When the transcript waits behind the placeholder. A channel opened from the roster waits for its
 * whole history — the stored thread and its voice chats. A channel just started from the compose
 * screen has no history to wait for: its first message is already in hand and must show at once,
 * not after a voice-chat request it cannot have anything in.
 */

test("a restoring channel waits", () => {
  expect(
    historyIsLoading({ restoring: true, seeded: false, voicePending: false }),
  ).toBe(true);
});

test("an opened channel waits for its voice chats", () => {
  expect(
    historyIsLoading({ restoring: false, seeded: false, voicePending: true }),
  ).toBe(true);
});

test("a channel started from the compose screen does not wait for voice chats", () => {
  expect(
    historyIsLoading({ restoring: false, seeded: true, voicePending: true }),
  ).toBe(false);
});

test("nothing left to wait for", () => {
  expect(
    historyIsLoading({ restoring: false, seeded: false, voicePending: false }),
  ).toBe(false);
});
