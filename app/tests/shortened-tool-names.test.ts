import { expect, test } from "bun:test";
import {
  knowShortenedToolNames,
  readToolName,
  wholeToolName,
} from "@openbot/shared/tool-name";

/*
 * FOUND IN TESTING. A step for Google Sheets' "update dimension properties" read "Update dimensi
 * 82883606": a long action's name travels cut to 64 characters and ended with a hash, and the step
 * was drawn from the cut name. The app is told what each cut name stands for and draws the action
 * by its whole name.
 *
 * Google Sheets' real long action names, as cut for the wire.
 */

const NAMES = {
  "mcp__composio-googlesheets__GOOGLESHEETS_UPDATE_DIMENSI_82883606":
    "mcp__composio-googlesheets__GOOGLESHEETS_UPDATE_DIMENSION_PROPERTIES",
  "mcp__composio-googlesheets__GOOGLESHEETS_SPREADSHEETS_V_6d5def0d":
    "mcp__composio-googlesheets__GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
  "mcp__composio-googlesheets__GOOGLESHEETS_MUTATE_CONDITI_c404f212":
    "mcp__composio-googlesheets__GOOGLESHEETS_MUTATE_CONDITIONAL_FORMAT_RULES",
  "mcp__composio-googlesheets__GOOGLESHEETS_SPREADSHEETS_V_0a62820b":
    "mcp__composio-googlesheets__GOOGLESHEETS_SPREADSHEETS_VALUES_BATCH_GET_BY_DATA_FILTER",
};

test("a shortened name not yet known reads as it stands, hash and all", () => {
  // What the report saw. Kept so the next test shows the change, not a coincidence.
  expect(
    readToolName(
      "mcp__composio-googlesheets__GOOGLESHEETS_UPDATE_DIMENSI_82883606",
    ).label,
  ).toContain("82883606");
});

test("a step for a long-named action is drawn by the action's whole name, never its cut name", () => {
  knowShortenedToolNames(NAMES);
  for (const [shortened, whole] of Object.entries(NAMES)) {
    const drawn = readToolName(shortened);
    // Exactly what the whole name draws: the same words, the same app.
    expect(drawn).toEqual(readToolName(whole));
    // And nothing of the hash.
    expect(drawn.label).not.toMatch(/[0-9a-f]{8}/);
    expect(wholeToolName(shortened)).toBe(whole);
  }
  expect(
    readToolName(
      "mcp__composio-googlesheets__GOOGLESHEETS_UPDATE_DIMENSI_82883606",
    ),
  ).toEqual({ label: "Update dimension properties", detail: "Googlesheets" });

  // A name that was never shortened is read as it always was.
  expect(
    readToolName("mcp__composio-googlesheets__GOOGLESHEETS_ADD_SHEET"),
  ).toEqual({ label: "Add sheet", detail: "Googlesheets" });
  expect(wholeToolName("search_tools")).toBe("search_tools");
});
