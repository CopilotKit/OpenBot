import { describe, expect, test } from "bun:test";
import { documentChipKind } from "../src/lib/markdown";

/**
 * Which links get drawn as a document chip.
 *
 * Recognition is by exact host and https only, because a chip asserts "this is a document in a
 * system you have connected" — a claim that must not be honored for an impostor domain or a
 * downgraded scheme.
 */
describe("recognising a document link", () => {
  test("a Google Doc URL is drawn as a Doc chip", () => {
    expect(documentChipKind("https://docs.google.com/document/d/x")).toEqual(
      expect.objectContaining({ label: "Doc" }),
    );
  });

  test("a Notion workspace page URL is drawn as a Notion chip", () => {
    expect(documentChipKind("https://www.notion.so/ws/Page-abc")).toEqual(
      expect.objectContaining({ label: "Notion" }),
    );
  });

  test("a bare notion.so URL is drawn as a Notion chip", () => {
    expect(documentChipKind("https://notion.so/abc")).toEqual(
      expect.objectContaining({ label: "Notion" }),
    );
  });

  test("a lookalike host is not a Notion document, even though it ends the same way", () => {
    expect(documentChipKind("https://notion.so.evil.test/x")).toBeNull();
  });

  test("a Notion URL over plain http is not a document chip", () => {
    expect(documentChipKind("http://www.notion.so/x")).toBeNull();
  });

  test("a relative href is not a document chip", () => {
    expect(documentChipKind("/some/relative/path")).toBeNull();
  });
});
