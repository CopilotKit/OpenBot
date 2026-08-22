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
