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

  test.each([undefined, "", "slack", "__proto__"])(
    "says nothing for %p",
    (value) => {
      expect(linkedNotice(value)).toBeNull();
    },
  );
});
