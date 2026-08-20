import { describe, expect, test } from "bun:test";
import { MAX_RESULT_CHARS, resultText } from "../src/plugins/mcp";

/**
 * What a vendor's answer looks like by the time a model reads it.
 *
 * Separated from the protocol so it can be asserted without a server to talk to. The case worth
 * having tests for is the empty one: a tool that matched nothing used to hand back an empty string,
 * and an empty string is the single most dangerous thing to put in front of a model. It reads as
 * "the tool had nothing to say" rather than "there is nothing there", and the model fills the gap
 * from memory — which is exactly the answer with nothing behind it that a knowledge connector must
 * never give.
 */

describe("a result with nothing in it", () => {
  test("says so, rather than being an empty string", () => {
    const { text } = resultText([]);
    expect(text).not.toBe("");
    expect(text.toLowerCase()).toContain("no content");
    // The clause that matters: it tells the model there is nothing here to answer from.
    expect(text.toLowerCase()).toContain("nothing");
  });

  test("treats whitespace and a missing content field the same as empty", () => {
    // A vendor sending a single newline has said nothing, and "nothing" should not depend on which
    // shape of nothing arrived.
    const blank = resultText([{ type: "text", text: "   \n  " }]).text;
    expect(blank).toBe(resultText([]).text);
    expect(resultText(undefined).text).toBe(resultText([]).text);
    expect(resultText("not an array").text).toBe(resultText([]).text);
  });

  test("is not reported as truncated", () => {
    expect(resultText([]).truncated).toBe(false);
  });
});

describe("a result with something in it", () => {
  test("is passed through as the vendor wrote it", () => {
    const { text, truncated } = resultText([
      {
        type: "text",
        text: "# Expense policy\n\nMeals under $75 need no receipt.",
      },
    ]);
    expect(text).toBe("# Expense policy\n\nMeals under $75 need no receipt.");
    expect(truncated).toBe(false);
  });

  test("joins several parts", () => {
    expect(
      resultText([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]).text,
    ).toBe("first\nsecond");
  });

  test("names a part it cannot read rather than dropping it", () => {
    // A model told "[image]" can say the tool returned an image. A model handed nothing concludes
    // the tool returned nothing, which is a different and false statement.
    expect(resultText([{ type: "image", data: "..." }]).text).toBe("[image]");
    expect(resultText([{}]).text).toBe("[unknown]");
  });

  test("a part that is only whitespace still counts as something being there", () => {
    // One blank part beside a real one must not make the whole result look empty.
    expect(
      resultText([
        { type: "text", text: " " },
        { type: "text", text: "real" },
      ]).text,
    ).toContain("real");
  });
});

describe("a result too large to hand a model", () => {
  test("is cut, and says that it was", () => {
    const enormous = "x".repeat(MAX_RESULT_CHARS + 500);
    const { text, truncated } = resultText([{ type: "text", text: enormous }]);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(enormous.length);
    // Visibly, never silently: a model that cannot tell it was given a fragment answers from the
    // fragment as though it were the whole thing.
    expect(text).toContain("truncated");
    expect(text).toContain(String(enormous.length));
  });

  test("a result exactly at the limit is left alone", () => {
    const exact = "x".repeat(MAX_RESULT_CHARS);
    const { text, truncated } = resultText([{ type: "text", text: exact }]);
    expect(truncated).toBe(false);
    expect(text).toBe(exact);
  });
});
