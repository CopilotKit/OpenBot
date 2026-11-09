import { expect, test } from "bun:test";
import {
  AUDIT_EVENT_WORDS,
  auditActionWords,
  auditEventWords,
  DATA_FUNCTION_WORDS,
  dataWords,
} from "@openbot/shared/audit-words";
import { auditEventTypes } from "../src/audit";
import { DATA_FUNCTIONS } from "../src/components/functions";

/**
 * Every event the trail records has words for Activity and Audit.
 *
 * A row's What used to be its stored name, so a person read "mcp.tools_discovered" and "write_file".
 * The words live in `shared/audit-words.ts`, and this file fails on a type registered here without
 * an entry there, so the next one added reaches the screen in words the day it lands.
 */

test("every registered audit event has words, and nothing else does", () => {
  const missing = auditEventTypes.filter(
    (type) => !Object.hasOwn(AUDIT_EVENT_WORDS, type),
  );
  expect(missing).toEqual([]);
  const stale = Object.keys(AUDIT_EVENT_WORDS).filter(
    (type) => !(auditEventTypes as readonly string[]).includes(type),
  );
  expect(stale).toEqual([]);
});

test("every data function a component can read has words, so a grant or a read names it", () => {
  const missing = DATA_FUNCTIONS.map(({ name }) => name).filter(
    (name) => !Object.hasOwn(DATA_FUNCTION_WORDS, name),
  );
  expect(missing).toEqual([]);
  expect(dataWords(["botActivity", "recentRefusals"])).toBe(
    "your Bots' activity and what was refused",
  );
});

test("no event's words are its stored name, or carry one", () => {
  for (const type of auditEventTypes) {
    const words = auditEventWords(type);
    expect(words).not.toContain(".");
    expect(words).not.toContain("_");
    expect(words.charAt(0)).toBe(words.charAt(0).toUpperCase());
    // Settings > Activity is anybody's page: no broker's name and no OAuth ("Register an OAuth client").
    expect(words).not.toMatch(/composio|arcade|oauth/i);
  }
});

test("an action reads as what was asked for, in the words a conversation uses for an app", () => {
  expect(auditActionWords("computer_write_file")).toBe("Save a file");
  expect(auditActionWords("host/read_file")).toBe("Read a file");
  // Older rows record a computer's action without its namespace.
  expect(auditActionWords("click")).toBe("Click on a page");
  expect(auditActionWords("parallel/web_search")).toBe("Search the web");
  expect(auditActionWords("composio-gmail/GMAIL_SEND_EMAIL")).toBe(
    "Send email",
  );
  expect(auditActionWords("gmail/*")).toBe("Use Gmail");
  expect(auditActionWords("bot/message_bot")).toBe("Ask another Bot");
  // A name with no words of its own is still split into words.
  expect(auditActionWords("computer_hover_element")).toBe("Hover element");
});
