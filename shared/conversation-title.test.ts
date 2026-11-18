import { describe, expect, test } from "bun:test";
import { checkInMessage } from "./check-in-message";
import { untitledLine } from "./conversation-title";

const spoke = checkInMessage({
  checkInId: "chk_inbox",
  ranAt: "2026-11-17T16:00:00.000Z",
  itemIds: ["itm_rosa", "itm_northwind"],
  message: "Good morning. Two emails need you today.",
});

describe("what a conversation is called before it has a name", () => {
  test("is the person's first words, over anything said since", () => {
    expect(
      untitledLine({
        opening: " Keep an eye on my inbox ",
        lastMessage: spoke,
      }),
    ).toBe("Keep an eye on my inbox");
  });

  test("is its last message where nobody spoke first", () => {
    expect(untitledLine({ lastMessage: " Filed the report. " })).toBe(
      "Filed the report.",
    );
  });

  test("is nothing for one nobody has used", () => {
    expect(untitledLine({})).toBeUndefined();
    expect(untitledLine({ opening: null, lastMessage: null })).toBeUndefined();
    expect(untitledLine({ opening: "  ", lastMessage: "" })).toBeUndefined();
  });
});

describe("a conversation a check-in opened by speaking first", () => {
  test("is called by the Bot's sentence, never by the marker in front of it", () => {
    expect(untitledLine({ lastMessage: spoke })).toBe(
      "Good morning. Two emails need you today.",
    );
  });

  test("one naming an app to connect is called by its sentence too", () => {
    expect(
      untitledLine({
        lastMessage: checkInMessage({
          checkInId: "chk_brief",
          ranAt: "2026-11-17T16:00:00.000Z",
          app: { serverId: "composio-gmail", title: "Gmail" },
          message: "I noticed you haven't connected your Gmail yet.",
        }),
      }),
    ).toBe("I noticed you haven't connected your Gmail yet.");
  });

  test("a preview cut off inside the marker names nothing, rather than showing half of it", () => {
    expect(untitledLine({ lastMessage: spoke.slice(0, 40) })).toBeUndefined();
  });
});
