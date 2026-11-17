import { describe, expect, test } from "bun:test";
import {
  CHECK_IN_MESSAGE_MARKER,
  checkInMessage,
  checkInMessageArriving,
  readCheckInMessage,
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

  test.each([
    ["nothing yet", ""],
    ["an ordinary reply", "Good morning."],
    ["a reply that opens with a link", "[Docs](https://example.com) cover it."],
    [
      "a marker that closed and reads as nothing",
      `${CHECK_IN_MESSAGE_MARKER}{} hi`,
    ],
  ])("is not arriving: %s", (_what, text) => {
    expect(checkInMessageArriving(text)).toBe(false);
  });
});
