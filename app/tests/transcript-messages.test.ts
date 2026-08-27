import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  seedMessage,
  stashFirstMessage,
  takeFirstMessage,
  transcriptMessages,
} from "../src/components/channels/transcript-messages";

/**
 * Brand-new channel transcript seeding: show the optimistic message until stored messages arrive.
 */

const SEED = seedMessage("what is our refund policy?", "seed-1");
const STORED = seedMessage("what is our refund policy?", "stored-1");
const REPLY: Message = {
  id: "reply-1",
  role: "assistant",
  content: "Thirty days, and we pay return shipping.",
};

describe("transcriptMessages", () => {
  test("shows the seed while the agent has nothing", () => {
    expect(transcriptMessages([], SEED)).toEqual([SEED]);
  });

  test("shows the agent's messages once it has any, and drops the seed", () => {
    expect(transcriptMessages([STORED], SEED)).toEqual([STORED]);
  });

  // A reply with no user turn in front of it means the seed is the only copy left, not that it
  // has been superseded.
  test("keeps the seed when the agent holds only a reply", () => {
    expect(transcriptMessages([REPLY], SEED)).toEqual([SEED, REPLY]);
  });

  test("drops the seed once a user turn stands alongside the reply", () => {
    expect(transcriptMessages([STORED, REPLY], SEED)).toEqual([STORED, REPLY]);
  });

  test("shows nothing for an empty channel with no seed", () => {
    expect(transcriptMessages([], null)).toEqual([]);
  });

  test("is unaffected by a seed on an established channel", () => {
    expect(transcriptMessages([STORED], null)).toEqual([STORED]);
  });
});

describe("seedMessage", () => {
  test("is a user message carrying the text", () => {
    const message = seedMessage("hello", "id-1");
    expect(message).toEqual({ id: "id-1", role: "user", content: "hello" });
  });
});

describe("the first-message stash", () => {
  test("hands the message to the channel that was just created", () => {
    stashFirstMessage("channel_a", "hello");
    expect(takeFirstMessage("channel_a")).toBe("hello");
  });

  test("gives it up only once", () => {
    // Take-once prevents remounts from resending the first message.
    stashFirstMessage("channel_b", "hello");
    takeFirstMessage("channel_b");
    expect(takeFirstMessage("channel_b")).toBeNull();
  });

  test("has nothing for a channel that was opened normally", () => {
    expect(takeFirstMessage("channel_never_stashed")).toBeNull();
  });

  test("keeps two channels' messages apart", () => {
    stashFirstMessage("channel_c", "for c");
    stashFirstMessage("channel_d", "for d");
    expect(takeFirstMessage("channel_d")).toBe("for d");
    expect(takeFirstMessage("channel_c")).toBe("for c");
  });
});
