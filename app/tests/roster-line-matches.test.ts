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

const LONG =
  "The cycle is on track and nothing is blocked, so the release goes out on Thursday as planned. " +
  "The only open item is the changelog, which Maya is finishing today, and the migration has been " +
  "rehearsed twice on staging without a single problem. Nothing else needs a decision from anyone.";

test("matches a reply against its line cut at 200 characters", () => {
  const line = `${LONG.slice(0, 200)}…`;
  expect(rosterLineMatches(LONG, line)).toBe(true);
});

test("does not match a long cut line whose words differ", () => {
  const line = `${LONG.slice(0, 200).replace("on track", "off track")}…`;
  expect(rosterLineMatches(LONG, line)).toBe(false);
});

test("does not treat a short line ending in an ellipsis as cut", () => {
  expect(
    rosterLineMatches(
      "The cycle is on track and nothing is blocked.",
      "The cycle is on…",
    ),
  ).toBe(false);
  expect(
    rosterLineMatches("Let me check the logs first.", "Let me check…"),
  ).toBe(false);
  expect(rosterLineMatches("Let me check…", "Let me check…")).toBe(true);
});

test("does not match when the words differ", () => {
  expect(rosterLineMatches("All is well.", "All is lost.")).toBe(false);
});

test("does not match when only the punctuation differs", () => {
  expect(rosterLineMatches("Done.", "Done!")).toBe(false);
  expect(rosterLineMatches("OK", "OK?")).toBe(false);
});

test("does not match an empty line", () => {
  expect(rosterLineMatches("All is well.", "")).toBe(false);
  expect(rosterLineMatches("", "")).toBe(false);
  expect(rosterLineMatches("All is well.", "…")).toBe(false);
});
