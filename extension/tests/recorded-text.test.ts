import { expect, test } from "bun:test";
import {
  CARD_AND_PIN_CLOCK,
  CODE_CLOCK,
  leakedSecrets,
  recordedText,
} from "./support/recorded-text";

/** A network event masked in full, made at `clock`. */
const maskedAt = (clock: number) => ({
  type: "CUSTOM",
  name: "network",
  timestamp: clock,
  value: {
    url: "https://bank.example.test/session",
    durationMs: 4111,
    completedAt: clock,
    request: {
      body: {
        status: "truncated",
        text: "pin=[redacted]&card_number=[redacted]",
        bytes: 3145835,
      },
    },
  },
});

test("the clock readings the tests pin hold the digits of the secrets they look for", () => {
  expect(String(CARD_AND_PIN_CLOCK)).toContain("4111");
  expect(String(CARD_AND_PIN_CLOCK)).toContain("4921");
  expect(String(CODE_CLOCK)).toContain("880261");
});

test("an event's timestamp, completion time and duration are never read as a leaked secret", () => {
  const event = maskedAt(1_792_433_411_150);
  // What the old check did: the whole event serialised, its clock included.
  expect(JSON.stringify(event)).toContain("4111");
  expect(leakedSecrets(event, ["4111", "4921"])).toEqual([]);
  expect(recordedText(event)).not.toContain("1792433411150");
});

test("a secret anywhere else in the event is still found: a string, a key, or a number that is no clock", () => {
  const event = maskedAt(CARD_AND_PIN_CLOCK);
  event.value.request.body.text = "pin=4921&card_number=4111+1111+1111+1111";
  expect(leakedSecrets(event, ["4111", "4921", "hunter2"])).toEqual([
    "4111",
    "4921",
  ]);
  expect(leakedSecrets({ "4111": true }, ["4111"])).toEqual(["4111"]);
  expect(leakedSecrets({ pin: 4921 }, ["4921"])).toEqual(["4921"]);
  expect(leakedSecrets([{ value: { bytes: 4111 } }], ["4111"])).toEqual([
    "4111",
  ]);
});

test("a number as large as a clock reading in a field no clock writes fails the check instead of slipping past it", () => {
  expect(() =>
    recordedText({ value: { firstByteAt: CARD_AND_PIN_CLOCK } }),
  ).toThrow(/"firstByteAt" holds 1749214111000/);
  // A card number recorded as a number is a leak, never a clock to skip.
  expect(() => leakedSecrets({ card: 4111111111111111 }, ["4111"])).toThrow(
    /"card" holds/,
  );
});

test("text the test itself made vary, such as its server's port, is left out when it is named", () => {
  const event = { value: { url: "http://127.0.0.1:54111/echo" } };
  expect(leakedSecrets(event, ["4111"])).toEqual(["4111"]);
  expect(
    leakedSecrets(event, ["4111"], { blank: ["127.0.0.1:54111"] }),
  ).toEqual([]);
});
