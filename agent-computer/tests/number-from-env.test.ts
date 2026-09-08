import { afterEach, describe, expect, test } from "bun:test";
import { numberFromEnv } from "../src/env";

const NAME = "OPENBOT_TEST_NUMBER_FROM_ENV";

afterEach(() => {
  delete process.env[NAME];
});

describe("numberFromEnv", () => {
  test("takes a positive number, trimming surrounding whitespace", () => {
    process.env[NAME] = "  5000 ";
    expect(numberFromEnv(NAME, 10000)).toBe(5000);
  });

  test("falls back when the variable is unset", () => {
    expect(numberFromEnv(NAME, 10000)).toBe(10000);
  });

  test("falls back on the empty string a compose file passes for an unset variable", () => {
    // The bug this guards: `Number.parseInt(process.env.X ?? "default")` sees "" here, not undefined,
    // so `??` never fires and the parse is NaN. An empty value means "not set" and takes the fallback.
    process.env[NAME] = "";
    expect(numberFromEnv(NAME, 10000)).toBe(10000);
  });

  test("falls back on a non-numeric value", () => {
    process.env[NAME] = "soon";
    expect(numberFromEnv(NAME, 10000)).toBe(10000);
  });

  test("falls back on zero and negatives, so a bad timeout is never enforced", () => {
    process.env[NAME] = "0";
    expect(numberFromEnv(NAME, 10000)).toBe(10000);
    process.env[NAME] = "-5";
    expect(numberFromEnv(NAME, 10000)).toBe(10000);
  });
});

/**
 * The setting where zero is an answer rather than a mistake.
 *
 * `COMPUTER_BROWSER_IDLE_MS=0` is documented as keeping browsers resident, and `chooseIdle` reads a
 * timeout of zero as the sweep being switched off. Neither was reachable: zero is not greater than
 * zero, so the operator who typed it got the thirty-minute default and the sweep they had switched
 * off went on closing their browsers.
 */
describe("numberFromEnv where zero switches the setting off", () => {
  test("keeps a zero an operator typed", () => {
    process.env[NAME] = "0";
    expect(numberFromEnv(NAME, 10000, { zeroSwitchesItOff: true })).toBe(0);
  });

  test("keeps a zero with whitespace around it, as a hand-edited .env has", () => {
    process.env[NAME] = "  0  ";
    expect(numberFromEnv(NAME, 10000, { zeroSwitchesItOff: true })).toBe(0);
  });

  test("still reads the empty string a compose file passes as unset, not as zero", () => {
    // The trap this whole function exists for, and the reason zero stays off by default: a variable
    // declared and left blank must not be read as an operator switching a sweep off.
    process.env[NAME] = "";
    expect(numberFromEnv(NAME, 10000, { zeroSwitchesItOff: true })).toBe(10000);
    delete process.env[NAME];
    expect(numberFromEnv(NAME, 10000, { zeroSwitchesItOff: true })).toBe(10000);
  });

  test("still falls back on a negative and on a value that is not a number", () => {
    // Off is spelled zero. Anything else that is not a length of time is a mistake, and a mistake
    // takes the default rather than switching something off on an operator's behalf.
    for (const bad of ["-5", "soon", "1e999"]) {
      process.env[NAME] = bad;
      expect(numberFromEnv(NAME, 10000, { zeroSwitchesItOff: true })).toBe(
        10000,
      );
    }
  });

  test("leaves an ordinary value alone", () => {
    process.env[NAME] = "5000";
    expect(numberFromEnv(NAME, 10000, { zeroSwitchesItOff: true })).toBe(5000);
  });
});
