import { expect, mock, test } from "bun:test";

// The phone's native parts don't exist off the phone; these tests only need the plain logic.
mock.module("expo-modules-core", () => ({
  requireOptionalNativeModule: () => null,
}));
mock.module("expo-file-system", () => ({
  File: class {
    exists = false;
  },
  Paths: { document: "" },
}));
mock.module("expo-notifications", () => ({}));
mock.module("expo-crypto", () => ({ randomUUID: () => "id" }));
mock.module("../src/api", () => ({ api: async () => ({}) }));

const { readNeedleAnswer, needleAvailable } = await import(
  "../modules/needle/src"
);
const { describe, phoneFacts, phoneTools, readWhen } = await import(
  "../src/phone-bot"
);

test("reads Needle's answer, including calls it held back", () => {
  const answer = readNeedleAnswer(
    JSON.stringify({
      type: "call",
      success: true,
      function_calls: [{ name: "save_note", arguments: { text: "buy milk" } }],
      suppressed_calls: [
        { name: "remind_me_in", arguments: { what: "tea", minutes: 5 } },
      ],
      confidence: 0.91,
      reasoning: "note",
    }),
  );
  expect(answer.calls).toEqual([
    { name: "save_note", arguments: { text: "buy milk" } },
  ]);
  expect(answer.unsure[0]?.name).toBe("remind_me_in");
  expect(answer.confidence).toBe(0.91);
  expect(() => readNeedleAnswer('{"error":-3}')).toThrow();
});

test("an empty answer is a plain no", () => {
  const answer = readNeedleAnswer(
    '{"type":"call","function_calls":[],"confidence":0.2}',
  );
  expect(answer.calls).toEqual([]);
  expect(answer.unsure).toEqual([]);
});

test("off the phone there is no Needle", () => {
  expect(needleAvailable()).toBe(false);
});

test("reads reminder times as local time", () => {
  const when = readWhen("2026-11-04 17:05");
  expect(when?.getFullYear()).toBe(2026);
  expect(when?.getMonth()).toBe(10);
  expect(when?.getHours()).toBe(17);
  expect(when?.getMinutes()).toBe(5);
  expect(readWhen("tomorrow")).toBeNull();
});

test("tells Needle the time as a fact", () => {
  expect(phoneFacts(new Date(2026, 10, 3, 9, 4))).toStartWith(
    "date: 2026-11-03 Tue 09:04;",
  );
});

test("offers the Bots it last saw by name", () => {
  const message = phoneTools(["Helper", "Writer"]).find(
    (tool) => tool.name === "message_bot",
  );
  expect(message?.parameters.properties.bot?.enum).toEqual([
    "Helper",
    "Writer",
  ]);
  expect(
    phoneTools([]).find((tool) => tool.name === "message_bot")?.parameters
      .properties.bot?.enum,
  ).toBeUndefined();
});

test("says what it is about to do in plain words", () => {
  expect(
    describe({
      name: "message_bot",
      arguments: { bot: "Helper", message: "check my email" },
    }),
  ).toBe('Give Helper the message "check my email"');
});
