import { describe, expect, test } from "bun:test";
import { readToolName } from "../src/lib/plugins/tool-name";

/**
 * What the person watching is told a Bot just did.
 *
 * The names under test are the ones the model is offered, which carry the server and a separator
 * that exists to keep two vendors' `search` apart. A reader should never see either.
 */
describe("naming a tool call", () => {
  test("a research call says what it did and not which provider did it", () => {
    for (const name of [
      "mcp__exa__web_search_exa",
      "mcp__exa-authenticated__web_search_exa",
      "mcp__parallel__web_search",
      "mcp__firecrawl__firecrawl_search",
    ]) {
      expect(readToolName(name)).toEqual({ label: "Search the web" });
    }
    expect(readToolName("mcp__exa__web_fetch_exa")).toEqual({
      label: "Read web pages",
    });
    expect(readToolName("mcp__firecrawl__firecrawl_scrape")).toEqual({
      label: "Read web pages",
    });
    // Only the research pair is relabelled; a provider's other tools keep their own names.
    expect(readToolName("mcp__firecrawl__firecrawl_map").label).toBe(
      "Firecrawl map",
    );
  });

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

  test("a brokered app's action is named without any vendor's prefix", () => {
    // Composio is how this deployment reaches Gmail, which is plumbing: the reader asked their Bot
    // about their email, not about which broker holds the grant. Composio also prefixes every tool
    // with the app, so the app is dropped from the action and named once, beside it.
    expect(readToolName("mcp__composio-gmail__GMAIL_FETCH_EMAILS")).toEqual({
      label: "Fetch emails",
      detail: "Gmail",
    });
    expect(readToolName("mcp__composio-airtable__AIRTABLE_LIST_BASES")).toEqual(
      { label: "List bases", detail: "Airtable" },
    );
    expect(
      readToolName("mcp__composio-googlecalendar__GOOGLECALENDAR_CREATE_EVENT"),
    ).toEqual({ label: "Create event", detail: "Googlecalendar" });
  });

  test("an action that does not lead with its app is kept whole, beside the app", () => {
    expect(readToolName("mcp__composio-gmail__FETCH_EMAILS")).toEqual({
      label: "Fetch emails",
      detail: "Gmail",
    });
  });

  test("an Arcade app is named as the app, never as arcade-", () => {
    // Arcade already strips its toolkit from the action, so only the broker prefix is left to drop.
    expect(readToolName("mcp__arcade-Gmail__ListEmails")).toEqual({
      label: "List emails",
      detail: "Gmail",
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

describe("this deployment's own tools", () => {
  test("show_app_access is named for what it is doing, then for what it did", () => {
    expect(readToolName("show_app_access", true)).toEqual({
      label: "Checking app access",
    });
    expect(readToolName("show_app_access")).toEqual({
      label: "Checked app access",
    });
  });

  test("any other bare name is left exactly as it is", () => {
    expect(readToolName("run_command", true)).toEqual({ label: "run_command" });
  });
});
