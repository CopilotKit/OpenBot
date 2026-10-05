import { describe, expect, test } from "bun:test";
import { parseAgentToolCallInput } from "../src/agents/callback-token";

/**
 * The shape a framework Bot's tool call arrives in, nailed down.
 *
 * The route used to guard with `if (!body?.name)` and then call `body.name.replace`,
 * so a truthy non-string (`123`, `{}`, `["mcp__x"]`) sailed through and threw a TypeError
 * inside the try, which the catch returned as a 200 refusal with the marker text. A caller
 * error looked like a tool saying no. `args` was never checked at all.
 */

describe("parseAgentToolCallInput", () => {
  test("accepts a plain tool name with absent args", () => {
    expect(
      parseAgentToolCallInput({ name: "server/tool", run: "signed" }),
    ).toEqual({
      ok: true,
      value: { ref: "server/tool", args: {} },
    });
  });

  test("trims the name and maps the mcp__ prefix the model is offered", () => {
    expect(
      parseAgentToolCallInput({
        name: "  mcp__server__tool  ",
        args: { q: 1 },
        run: "signed",
      }),
    ).toEqual({
      ok: true,
      value: { ref: "server/tool", args: { q: 1 } },
    });
  });

  test("keeps extra body fields out of the parsed value", () => {
    const parsed = parseAgentToolCallInput({
      name: "server/tool",
      args: {},
      run: "signed",
      botId: "forged",
      actorId: "forged",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { ref: "server/tool", args: {} },
    });
  });

  test.each([[null], [undefined], ["name"], [42], [true], [[]]])(
    "refuses a non-object body: %p",
    (body) => {
      expect(parseAgentToolCallInput(body)).toEqual({
        ok: false,
        error: "A tool is required.",
      });
    },
  );

  test.each([
    ["missing", {}, "A tool is required."],
    ["null", { name: null }, "A tool is required."],
    ["a number", { name: 123 }, "A tool is required."],
    ["an object", { name: {} }, "A tool is required."],
    ["an array", { name: ["mcp__server__tool"] }, "A tool is required."],
    ["a boolean", { name: true }, "A tool is required."],
    ["empty", { name: "" }, "A tool is required."],
    ["whitespace", { name: "   " }, "A tool is required."],
  ])("refuses %s name with 400", (_label, body, error) => {
    expect(parseAgentToolCallInput(body)).toEqual({ ok: false, error });
  });

  test.each([
    ["a string", "str"],
    ["a number", 42],
    ["null", null],
    ["an array", []],
    ["an array of pairs", [["q", 1]]],
    ["a boolean", true],
  ])("refuses %s args with 400", (_label, args) => {
    expect(parseAgentToolCallInput({ name: "server/tool", args })).toEqual({
      ok: false,
      error: "Tool arguments must be an object.",
    });
  });

  test("accepts an empty object for args", () => {
    expect(parseAgentToolCallInput({ name: "s/t", args: {} })).toEqual({
      ok: true,
      value: { ref: "s/t", args: {} },
    });
  });

  test("a name that trims to nothing is still a missing tool", () => {
    expect(parseAgentToolCallInput({ name: "\n\t " })).toEqual({
      ok: false,
      error: "A tool is required.",
    });
  });

  test("never calls a string method on the input: numbers do not throw", () => {
    expect(() =>
      parseAgentToolCallInput({ name: 123, args: 42 }),
    ).not.toThrow();
    expect(parseAgentToolCallInput({ name: 123, args: 42 })).toEqual({
      ok: false,
      error: "A tool is required.",
    });
  });
});
