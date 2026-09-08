import { describe, expect, test } from "bun:test";
import { readToolName } from "./tool-name";

describe("readToolName", () => {
  test("drops the server when the action already names it", () => {
    expect(readToolName("mcp__notes__search_notes")).toEqual({
      label: "Search notes",
    });
  });

  test("drops the server when the action names it in the singular", () => {
    expect(readToolName("mcp__routines__create_routine")).toEqual({
      label: "Create routine",
    });
  });

  test("keeps the server when the action does not name it", () => {
    expect(readToolName("mcp__slack__send_message")).toEqual({
      label: "Send message",
      detail: "slack",
    });
  });

  test("leaves a name that is not a prefixed MCP id exactly as it is", () => {
    expect(readToolName("renderChart")).toEqual({ label: "renderChart" });
  });
});
