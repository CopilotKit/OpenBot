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

  test("the server is dropped when the action names it in the singular", () => {
    // A vendor names the server for the collection and the tool for the one item it acts on, so the
    // label is singular where the server is plural. The reader should not be shown "Create routine
    // routines".
    expect(readToolName("mcp__routines__create_routine")).toEqual({
      label: "Create routine",
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

  test("the server is dropped when a hyphenated server's words are already in the label", () => {
    // The server is one token with a separator inside it, `google-drive`. A word-at-a-time compare
    // against the label's words never matches a token that never appears as a whole word itself, so
    // this needs the same splitting `humanise` already does for the tool name.
    expect(readToolName("mcp__google-drive__search_google_drive")).toEqual({
      label: "Search google drive",
    });
  });

  test("the server is dropped when an underscored server's words are already in the label", () => {
    // Same case as the hyphenated server, spelled with an underscore instead. Either separator has to
    // split into the same words.
    expect(readToolName("mcp__google_drive__search_google_drive")).toEqual({
      label: "Search google drive",
    });
  });

  test("a multi-token server the label does not name is kept as detail", () => {
    // "Search files" does not say "google" or "drive" anywhere, so the server still belongs on
    // screen. This is what proves the check was tightened rather than deleted.
    expect(readToolName("mcp__google-drive__search_files")).toEqual({
      label: "Search files",
      detail: "google-drive",
    });
  });

  test("the server is kept when the singular of its name only matches the label's verb", () => {
    // singular("posts") is "post", which is also the verb `humanise` put first in "Post message".
    // That is a coincidence with the verb, not the server being named as the thing acted upon, so
    // "posts" still belongs on screen.
    expect(readToolName("mcp__posts__post_message")).toEqual({
      label: "Post message",
      detail: "posts",
    });
  });

  test("the server is kept when the singular of its name only matches the label's verb, second case", () => {
    // Same shape as `posts`/`post_message`: singular("lists") is "list", which collides with the
    // verb in "List files" rather than naming the server as the thing acted upon.
    expect(readToolName("mcp__lists__list_files")).toEqual({
      label: "List files",
      detail: "lists",
    });
  });
});
