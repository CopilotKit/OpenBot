import { describe, expect, test } from "bun:test";
import { readToolName } from "../src/lib/plugins/tool-name";

/**
 * What the person watching is told a Bot just did.
 *
 * The names under test are the ones the model is offered, which carry the server and a separator
 * that exists to keep two vendors' `search` apart. A reader should never see either.
 */
describe("naming a tool call", () => {
  test("an MCP tool reads as an action against a named server", () => {
    expect(readToolName("mcp__slack__post_message")).toEqual({
      label: "Post message",
      detail: "slack",
    });
  });

  test("the server is dropped when the action already names it", () => {
    // "Search notes notes" reads as a bug rather than a label.
    expect(readToolName("mcp__notes__search_notes")).toEqual({
      label: "Search notes",
    });
  });

  test("camelCase from a vendor reads the same way", () => {
    // The server is dropped here too: the vendor put it in the tool name themselves.
    expect(readToolName("mcp__jira__searchJiraIssues")).toEqual({
      label: "Search jira issues",
    });
  });

  test("a tool name containing the separator keeps all of it", () => {
    // The server is the first segment and everything after it is the tool, however many
    // separators the vendor used.
    expect(readToolName("mcp__box__list__files")).toEqual({
      label: "List files",
      detail: "box",
    });
  });

  test("a component the app registered is left alone", () => {
    // These names were chosen by somebody and are already what the reader should see.
    expect(readToolName("showBarChart")).toEqual({ label: "showBarChart" });
  });
});
