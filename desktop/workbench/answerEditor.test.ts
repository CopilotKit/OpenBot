import { describe, expect, test } from "bun:test";
import { parseAnswer } from "./answerEditor";

function jsonMessage(text: string): string {
  try {
    JSON.parse(text);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected invalid JSON");
}

describe("parseAnswer", () => {
  test("value takes valid JSON", () => {
    expect(parseAnswer("value", '{"a":1}')).toEqual({
      answer: { mode: "value", value: { a: 1 } },
    });
  });

  test("bad JSON gives the parser's message", () => {
    const result = parseAnswer("value", "{nope");
    expect(result).toEqual({
      error: `The JSON is not valid: ${jsonMessage("{nope")}`,
    });
  });

  test("never ignores the text", () => {
    expect(parseAnswer("never", "{bad")).toEqual({ answer: { mode: "never" } });
  });

  test("fail needs a said text", () => {
    expect(parseAnswer("fail", '{"code":1}')).toEqual({
      error: "A problem needs a said text.",
    });
    expect(parseAnswer("fail", "null")).toEqual({
      error: "A problem needs a said text.",
    });
  });

  test("fail with said", () => {
    expect(parseAnswer("fail", '{"said":"It broke."}')).toEqual({
      answer: { mode: "fail", problem: { said: "It broke." } },
    });
  });

  test("fail with bad JSON gives the JSON error", () => {
    expect(parseAnswer("fail", "{")).toEqual({
      error: `The JSON is not valid: ${jsonMessage("{")}`,
    });
  });

  test("delay with ms", () => {
    expect(parseAnswer("delay", "1", 50)).toEqual({
      answer: { mode: "delay", ms: 50, value: 1 },
    });
  });

  test("delay without a valid ms", () => {
    const error = {
      error: "The delay needs a number of milliseconds, 0 or more.",
    };
    expect(parseAnswer("delay", "1")).toEqual(error);
    expect(parseAnswer("delay", "1", -1)).toEqual(error);
    expect(parseAnswer("delay", "1", Number.NaN)).toEqual(error);
  });
});
