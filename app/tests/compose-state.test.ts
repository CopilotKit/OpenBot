import { describe, expect, test } from "bun:test";
import {
  addRecipient,
  canSend,
  MAX_RECIPIENTS,
  removeRecipient,
} from "../src/components/channels/compose-state";

const KNOWLEDGE = { id: "knowledge", name: "Knowledge" };
const RISK = { id: "risk-analyst", name: "Risk Analyst" };

describe("addRecipient", () => {
  test("adds to an empty list", () => {
    expect(addRecipient([], KNOWLEDGE)).toEqual([KNOWLEDGE]);
  });

  test("replaces rather than appends once the cap is reached", () => {
    // One teammate per channel today; a second pick replaces the first.
    expect(addRecipient([KNOWLEDGE], RISK)).toEqual([RISK]);
  });

  test("adding the teammate already chosen is a no-op", () => {
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
  test("needs exactly one recipient and some text", () => {
    expect(canSend([KNOWLEDGE], "hello")).toBe(true);
  });

  test("refuses with no recipient", () => {
    expect(canSend([], "hello")).toBe(false);
  });

  test("refuses whitespace-only text", () => {
    expect(canSend([KNOWLEDGE], "   ")).toBe(false);
  });

  test("cap is one", () => {
    expect(MAX_RECIPIENTS).toBe(1);
  });
});
