import { describe, expect, test } from "bun:test";
import { linkedNotice, visibleLinkedNotice } from "./linked-notice";

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
      text: "Your GitHub account could not be linked. Try again.",
    });
  });

  test("tells the person the GitHub account belongs to another user, as an alert", () => {
    expect(linkedNotice("github-taken")).toEqual({
      tone: "error",
      text: "That GitHub account is already linked to another OpenBot user. Sign in to GitHub as a different account and connect again, or ask your OpenBot administrator for help.",
    });
  });

  test.each([undefined, "", "slack", "__proto__"])(
    "says nothing for %p",
    (value) => {
      expect(linkedNotice(value)).toBeNull();
    },
  );
});

describe("visibleLinkedNotice", () => {
  const success = linkedNotice("github");
  const github = { provider: "github" as const };
  const slack = { provider: "slack" as const };

  test("shows the success notice while a GitHub link exists", () => {
    expect(visibleLinkedNotice(success, [slack, github])).toEqual(success);
  });

  test("hides the success notice once the GitHub link is gone", () => {
    expect(visibleLinkedNotice(success, [slack])).toBeNull();
    expect(visibleLinkedNotice(success, [])).toBeNull();
  });

  test("hides the success notice until the links have loaded", () => {
    expect(visibleLinkedNotice(success, undefined)).toBeNull();
  });

  test.each(["failed", "github-taken"])(
    "leaves the %s error notice alone whatever the links say",
    (value) => {
      const notice = linkedNotice(value);
      expect(visibleLinkedNotice(notice, [])).toEqual(notice);
      expect(visibleLinkedNotice(notice, undefined)).toEqual(notice);
    },
  );

  test("passes no notice through as none", () => {
    expect(visibleLinkedNotice(null, [github])).toBeNull();
  });
});
