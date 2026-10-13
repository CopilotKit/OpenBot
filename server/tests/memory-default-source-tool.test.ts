import { describe, expect, test } from "bun:test";
import { defaultSourceTool } from "../src/memory/ingestion";

const read = (name: string, inputSchema: Record<string, unknown> = {}) => ({
  ref: `app/${name}`,
  name,
  effect: "read" as const,
  destructive: false,
  inputSchema,
});

describe("the default memory source for an app", () => {
  // A default saves `{}` as its arguments, so an action that needs one would fail every sync, and
  // the broken source would then stand in the way of the one that works.
  test.each([
    ["allOf", { allOf: [{ required: ["query"] }] }],
    ["anyOf", { anyOf: [{ required: ["query"] }] }],
    ["oneOf", { oneOf: [{ required: ["query"] }] }],
    // JSON Schema's conditional really is named `then`; parsed, so it is never a thenable literal.
    ["a conditional", JSON.parse('{"if":{},"then":{"required":["query"]}}')],
    ["a $ref", { $ref: "#/$defs/search" }],
    ["top level", { required: ["query"] }],
  ])(
    "never an action whose arguments are required through %s",
    (_how, schema) => {
      const search = read("SEARCH_ISSUES", { type: "object", ...schema });
      const list = read("LIST_ISSUES", { type: "object", properties: {} });
      expect(defaultSourceTool([search, list])?.name).toBe("LIST_ISSUES");
      expect(defaultSourceTool([search])).toBeNull();
    },
  );

  test("an action that publishes no schema, or asks for nothing, still qualifies", () => {
    expect(defaultSourceTool([read("LIST_ISSUES")])?.name).toBe("LIST_ISSUES");
    expect(
      defaultSourceTool([
        read("SEARCH_ISSUES", {
          type: "object",
          properties: { query: { type: "string" } },
        }),
      ])?.name,
    ).toBe("SEARCH_ISSUES");
  });
});
