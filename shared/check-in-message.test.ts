import { describe, expect, test } from "bun:test";
import {
  CHECK_IN_MESSAGE_MARKER,
  checkInMessage,
  checkInMessageArriving,
  checkInWords,
  itemDetail,
  readCheckInMessage,
  readItemDetail,
} from "./check-in-message";

const said = {
  checkInId: "chk_inbox",
  ranAt: "2026-11-17T16:00:00.000Z",
  itemIds: ["itm_rosa", "itm_northwind"],
  message: "Good morning. Two emails need you today.",
};

describe("a check-in speaking first", () => {
  test("survives the round trip", () => {
    expect(readCheckInMessage(checkInMessage(said))).toEqual(said);
  });

  test("is the marker, its JSON and then the Bot's own sentence", () => {
    expect(checkInMessage(said)).toBe(
      `${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk_inbox","ranAt":"2026-11-17T16:00:00.000Z","itemIds":["itm_rosa","itm_northwind"]} Good morning. Two emails need you today.`,
    );
  });

  test("keeps the sentence readable for anything that cannot parse it", () => {
    // A surface that knows nothing of the marker still ends on what the Bot said.
    expect(checkInMessage(said).endsWith(said.message)).toBe(true);
  });

  test("keeps a sentence that has braces of its own", () => {
    const message = "The template still reads {{first_name}} in two places.";
    expect(
      readCheckInMessage(checkInMessage({ ...said, message }))?.message,
    ).toBe(message);
  });

  test("names each item once, in the order the check-in raised them", () => {
    const text = `${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk","ranAt":"2026-11-17T16:00:00Z","itemIds":["b","a","b"]} Two things.`;
    expect(readCheckInMessage(text)?.itemIds).toEqual(["b", "a"]);
  });

  test("with nothing said after the marker, the message is empty rather than missing", () => {
    const text = checkInMessage({ ...said, message: "" });
    expect(readCheckInMessage(text)).toEqual({ ...said, message: "" });
  });
});

const notConnected = {
  checkInId: "chk_brief",
  ranAt: "2026-11-17T16:00:00.000Z",
  app: { serverId: "composio-gmail", title: "Gmail" },
  message:
    "Good morning. I noticed you haven't connected your Gmail yet. Connect it and I'll brief you each morning.",
};

describe("a check-in that could not look, naming the app to connect", () => {
  test("survives the round trip", () => {
    expect(readCheckInMessage(checkInMessage(notConnected))).toEqual(
      notConnected,
    );
  });

  test("is the marker, its JSON with the app in connect-prompt's terms, and then the sentence", () => {
    expect(checkInMessage(notConnected)).toBe(
      `${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk_brief","ranAt":"2026-11-17T16:00:00.000Z","app":{"serverId":"composio-gmail","title":"Gmail"}} ${notConnected.message}`,
    );
  });

  test("carries the Bot whose check-in it was, and leaves it out when there is none", () => {
    const named = {
      ...notConnected,
      app: { ...notConnected.app, agentId: "general-assistant" },
    };
    expect(readCheckInMessage(checkInMessage(named))).toEqual(named);
    expect(checkInMessage(notConnected)).not.toContain("agentId");
  });

  test("a Bot of the wrong shape is dropped, and the message still names its app", () => {
    const text = `${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk_brief","ranAt":"2026-11-17T16:00:00Z","app":{"serverId":"composio-gmail","title":"Gmail","agentId":7}} Connect it.`;
    expect(readCheckInMessage(text)).toEqual({
      checkInId: "chk_brief",
      ranAt: "2026-11-17T16:00:00Z",
      app: { serverId: "composio-gmail", title: "Gmail" },
      message: "Connect it.",
    });
  });

  test("an app whose name has a brace in it still ends where its JSON ends", () => {
    const braced = {
      ...notConnected,
      app: { serverId: "notes", title: 'Notes {beta} "2"' },
    };
    expect(readCheckInMessage(checkInMessage(braced))).toEqual(braced);
  });
});

describe("text that is not one", () => {
  const json = (fields: Record<string, unknown>) =>
    `${CHECK_IN_MESSAGE_MARKER}${JSON.stringify(fields)} hello`;
  const whole = {
    checkInId: "chk",
    ranAt: "2026-11-17T16:00:00Z",
    itemIds: ["itm"],
  };

  test.each([
    ["an ordinary reply", "Good morning. Two emails need you today."],
    ["nothing at all", ""],
    [
      "the marker quoted mid-sentence",
      `It starts with ${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk"}`,
    ],
    ["a truncated marker", `${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk"`],
    ["JSON that is not an object", `${CHECK_IN_MESSAGE_MARKER}"chk"} hello`],
    ["a missing check-in", json({ ...whole, checkInId: undefined })],
    ["an empty check-in id", json({ ...whole, checkInId: "" })],
    ["a check-in id of the wrong type", json({ ...whole, checkInId: 7 })],
    ["a missing time", json({ ...whole, ranAt: undefined })],
    ["a time that is no instant", json({ ...whole, ranAt: "this morning" })],
    ["no list of items", json({ ...whole, itemIds: undefined })],
    ["items that are not a list", json({ ...whole, itemIds: "itm" })],
    ["a check-in that raised nothing", json({ ...whole, itemIds: [] })],
    ["an item id of the wrong type", json({ ...whole, itemIds: ["itm", 7] })],
    ["an empty item id", json({ ...whole, itemIds: ["itm", ""] })],
    [
      "items and an app at once",
      json({ ...whole, app: { serverId: "gmail", title: "Gmail" } }),
    ],
    [
      "an app that is not an object",
      json({ ...whole, itemIds: undefined, app: "gmail" }),
    ],
    [
      "an app with no id",
      json({ ...whole, itemIds: undefined, app: { title: "Gmail" } }),
    ],
    [
      "an app with no name",
      json({
        ...whole,
        itemIds: undefined,
        app: { serverId: "gmail", title: "" },
      }),
    ],
    [
      "an app whose JSON never closes",
      `${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk","ranAt":"2026-11-17T16:00:00Z","app":{"serverId":"gmail","title":"Gmail"} hello`,
    ],
  ])("reads as no check-in: %s", (_what, text) => {
    expect(readCheckInMessage(text)).toBeNull();
  });

  test("undefined and null read as no check-in", () => {
    expect(readCheckInMessage(undefined)).toBeNull();
    expect(readCheckInMessage(null)).toBeNull();
  });
});

describe("a check-in's message still being written", () => {
  test("is arriving at every length short of its JSON, and never once that has closed", () => {
    const text = checkInMessage(said);
    const closes = text.indexOf("}");
    for (let length = 1; length <= closes; length++) {
      expect(checkInMessageArriving(text.slice(0, length))).toBe(true);
      expect(readCheckInMessage(text.slice(0, length))).toBeNull();
    }
    for (let length = closes + 1; length <= text.length; length++) {
      expect(checkInMessageArriving(text.slice(0, length))).toBe(false);
      expect(readCheckInMessage(text.slice(0, length))).not.toBeNull();
    }
  });

  test("one that names an app is arriving until its outer JSON closes, not its app's", () => {
    const text = checkInMessage(notConnected);
    const closes = text.indexOf("}}") + 1;
    for (let length = 1; length <= closes; length++) {
      expect(checkInMessageArriving(text.slice(0, length))).toBe(true);
      expect(readCheckInMessage(text.slice(0, length))).toBeNull();
    }
    for (let length = closes + 1; length <= text.length; length++) {
      expect(checkInMessageArriving(text.slice(0, length))).toBe(false);
      expect(readCheckInMessage(text.slice(0, length))).not.toBeNull();
    }
  });

  test.each([
    ["nothing yet", ""],
    ["an ordinary reply", "Good morning."],
    [
      "a reply that only opens with the same word in brackets",
      `${CHECK_IN_MESSAGE_MARKER} ran at eight and found nothing`,
    ],
    ["a reply that opens with a link", "[Docs](https://example.com) cover it."],
    [
      "a marker that closed and reads as nothing",
      `${CHECK_IN_MESSAGE_MARKER}{} hi`,
    ],
  ])("is not arriving: %s", (_what, text) => {
    expect(checkInMessageArriving(text)).toBe(false);
  });
});

describe("a message as a line of words, where no card is drawn", () => {
  test("a check-in's message is its sentence", () => {
    expect(checkInWords(checkInMessage(said))).toBe(said.message);
    expect(checkInWords(checkInMessage(notConnected))).toBe(
      notConnected.message,
    );
  });

  test.each([
    ["an ordinary reply", "Good morning. Two emails need you today."],
    ["nothing at all", ""],
    [
      "the marker quoted mid-sentence",
      `It starts with ${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk"}`,
    ],
    [
      "a reply that only opens with the same word in brackets",
      `${CHECK_IN_MESSAGE_MARKER} ran at eight and found nothing`,
    ],
  ])("any other text is itself: %s", (_what, text) => {
    expect(checkInWords(text)).toBe(text);
  });

  test("a marker the transcript would not read still shows only its words", () => {
    // Drawn as written in the transcript, where a broken message should be seen. Not in a sidebar.
    expect(
      checkInWords(
        `${CHECK_IN_MESSAGE_MARKER}{"checkInId":"chk"} Good morning.`,
      ),
    ).toBe("Good morning.");
  });

  test("a preview cut off before the marker's JSON closed has no words in it", () => {
    const text = checkInMessage(said);
    for (let length = CHECK_IN_MESSAGE_MARKER.length + 1; ; length++) {
      const cut = text.slice(0, length);
      if (cut.includes("}")) break;
      expect(checkInWords(cut)).toBe("");
    }
  });

  test("a preview cut off inside the sentence keeps what there is of it", () => {
    const text = checkInMessage(said);
    expect(checkInWords(text.slice(0, text.indexOf("Two emails")))).toBe(
      "Good morning.",
    );
  });
});

describe("what the Bot would do about an item, in the item's own detail", () => {
  const why =
    "She asked if 2:00 PM still works and is holding the room until noon.";
  const wouldDo =
    "I'd draft a reply accepting 2:00 PM for you to read before it's sent.";

  test("is the second paragraph, and survives the round trip", () => {
    expect(itemDetail({ why, wouldDo })).toBe(`${why}\n\n${wouldDo}`);
    expect(readItemDetail(itemDetail({ why, wouldDo }))).toEqual({
      why,
      wouldDo,
    });
  });

  test("a detail of one paragraph is all why, as it always was", () => {
    expect(readItemDetail(why)).toEqual({ why, wouldDo: null });
    expect(itemDetail({ why, wouldDo: null })).toBe(why);
    expect(itemDetail({ why, wouldDo: "   " })).toBe(why);
  });

  test("a line break inside the why is not a new paragraph", () => {
    const twoLines = "The quote expires Friday.\nFinance approved the number.";
    expect(readItemDetail(twoLines)).toEqual({ why: twoLines, wouldDo: null });
  });

  test.each([
    ["blank lines with spaces in them", `${why}\n  \n${wouldDo}`],
    ["several blank lines", `${why}\n\n\n\n${wouldDo}`],
    ["Windows line endings", `${why}\r\n\r\n${wouldDo}`],
    ["space around the whole", `\n ${why}\n\n${wouldDo} \n`],
  ])("paragraphs are parted by a blank line: %s", (_what, detail) => {
    expect(readItemDetail(detail)).toEqual({ why, wouldDo });
  });

  test("everything after the first paragraph is kept", () => {
    expect(readItemDetail(`${why}\n\n${wouldDo}\n\nThen file it.`)).toEqual({
      why,
      wouldDo: `${wouldDo}\n\nThen file it.`,
    });
  });

  test("no detail at all reads as nothing, not as a failure", () => {
    expect(readItemDetail("")).toEqual({ why: "", wouldDo: null });
    expect(readItemDetail(null)).toEqual({ why: "", wouldDo: null });
    expect(readItemDetail(undefined)).toEqual({ why: "", wouldDo: null });
  });
});
