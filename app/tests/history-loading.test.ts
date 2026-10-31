import { expect, test } from "bun:test";
import {
  historyIsLoading,
  VOICE_WAIT_MS,
} from "@/components/channels/channel-chat";
import { voiceSessionQueryOptions } from "@/lib/voice/archive";

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

/*
 * A slow or failing voice service must not hold up text chat: once the thread is in, the voice chats
 * get VOICE_WAIT_MS more, and the conversation shows without them after that. A failure is final at
 * once rather than retried behind the placeholder.
 */
test("a channel stops waiting for voice chats that take too long", () => {
  expect(
    historyIsLoading({
      restoring: false,
      seeded: false,
      voicePending: true,
      voiceWaitedOut: true,
    }),
  ).toBe(false);
});

test("a failed voice-chat load is not retried behind the placeholder", () => {
  expect(voiceSessionQueryOptions("c1").retry).toBe(false);
});

test("the wait for voice chats is short", () => {
  expect(VOICE_WAIT_MS).toBeLessThanOrEqual(1500);
});
