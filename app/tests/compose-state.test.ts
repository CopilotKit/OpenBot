import { describe, expect, test } from "bun:test";
import {
  addRecipient,
  canSend,
  MAX_RECIPIENTS,
  removeRecipient,
  startsGroup,
  toFieldChange,
} from "../src/components/channels/compose-state";

const KNOWLEDGE = { id: "knowledge", name: "Knowledge" };
const RISK = { id: "risk-analyst", name: "Risk Analyst" };

describe("addRecipient", () => {
  test("adds to an empty list", () => {
    expect(addRecipient([], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });

  test("a second Bot is added after the first, in the order they will answer", () => {
    expect(addRecipient([KNOWLEDGE], RISK)).toEqual([KNOWLEDGE, RISK]);
  });

  test("past the cap, the earliest pick gives way", () => {
    const many = Array.from({ length: MAX_RECIPIENTS }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`,
    }));
    const added = addRecipient(many, RISK);
    expect(added).toHaveLength(MAX_RECIPIENTS);
    expect(added.at(-1)).toEqual(RISK);
    expect(added[0]?.id).toBe("bot-1");
  });

  test("adding the coworker already chosen is a no-op", () => {
    expect(addRecipient([KNOWLEDGE], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });
});

describe("removeRecipient", () => {
  test("removes by id", () => {
    expect(removeRecipient([KNOWLEDGE], "knowledge")).toEqual([]);
  });

  test("ignores an id that is not present", () => {
    expect(removeRecipient([KNOWLEDGE], "nobody")).toEqual([KNOWLEDGE]);
  });
});

describe("canSend", () => {
  test("needs at least one recipient and some text", () => {
    expect(canSend([KNOWLEDGE], "hello")).toBe(true);
    expect(canSend([KNOWLEDGE, RISK], "hello")).toBe(true);
  });

  test("refuses with no recipient", () => {
    expect(canSend([], "hello")).toBe(false);
  });

  test("refuses whitespace-only text", () => {
    expect(canSend([KNOWLEDGE], "   ")).toBe(false);
  });

  test("the cap is the server's limit for a group", () => {
    expect(MAX_RECIPIENTS).toBe(20);
  });
});

describe("startsGroup", () => {
  test("one Bot is a conversation, two or more are a group", () => {
    expect(startsGroup([KNOWLEDGE])).toBe(false);
    expect(startsGroup([KNOWLEDGE, RISK])).toBe(true);
  });
});

describe("toFieldChange", () => {
  test("a pick or a removal in the To: field is kept", () => {
    expect(toFieldChange([KNOWLEDGE], [KNOWLEDGE, RISK], "item-press")).toEqual(
      [KNOWLEDGE, RISK],
    );
    expect(
      toFieldChange([KNOWLEDGE, RISK], [RISK], "chip-remove-press"),
    ).toEqual([RISK]);
  });

  test("Escape does not throw away the Bots already picked", () => {
    expect(toFieldChange([KNOWLEDGE, RISK], [], "escape-key")).toEqual([
      KNOWLEDGE,
      RISK,
    ]);
  });
});
