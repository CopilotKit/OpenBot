import { describe, expect, test } from "bun:test";
import { linkedNotice } from "./linked-notice";

describe("linkedNotice", () => {
  test("reports a linked GitHub account", () => {
    expect(linkedNotice("github")).toEqual({
      tone: "success",
      text: "Your GitHub account is linked.",
    });
  });

  test("reports a failed link", () => {
    expect(linkedNotice("failed")).toEqual({
      tone: "error",
      text: "That account could not be linked. Nothing was saved — try again.",
    });
  });

  test("tells the person the GitHub account belongs to another user, as an alert", () => {
    expect(linkedNotice("github-taken")).toEqual({
      tone: "error",
      text: "That GitHub account is already linked to another OpenBot user. Disconnect it there first, or connect a different GitHub account.",
    });
  });

  test.each([undefined, "", "slack", "__proto__"])(
    "says nothing for %p",
    (value) => {
      expect(linkedNotice(value)).toBeNull();
    },
  );
});
