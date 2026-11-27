import { expect, test } from "bun:test";
import { rosterLineMatches } from "@/lib/channels/run-reply";

test("matches a plain one-line reply", () => {
  expect(rosterLineMatches("All is well.", "All is well.")).toBe(true);
});

test("matches a reply with Markdown and paragraphs", () => {
  expect(
    rosterLineMatches(
      "Here is **the plan**:\n\n- one\n- two",
      "Here is the plan: one two",
    ),
  ).toBe(true);
});

test("matches the start of a reply against a line cut with an ellipsis", () => {
  expect(
    rosterLineMatches(
      "The cycle is on track and nothing is blocked.",
      "The cycle is on…",
    ),
  ).toBe(true);
});

test("does not match when the words differ", () => {
  expect(rosterLineMatches("All is well.", "All is lost.")).toBe(false);
  expect(rosterLineMatches("All is well.", "All is…")).toBe(true);
  expect(rosterLineMatches("All is well.", "All is lost…")).toBe(false);
});

test("does not match an empty line", () => {
  expect(rosterLineMatches("All is well.", "")).toBe(false);
  expect(rosterLineMatches("", "")).toBe(false);
  expect(rosterLineMatches("All is well.", "…")).toBe(false);
});
