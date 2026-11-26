/**
 * The cards the phone announces to OpenBot, so a Bot is offered them even where nobody has opened the web app.
 */
import { expect, test } from "bun:test";
import { ANNOUNCED } from "../src/gallery/announced";
import { SHOWN } from "../src/gallery/drawn";

test("every card the phone draws that only shows something is announced, once, and nothing else", () => {
  const names = ANNOUNCED.map((entry) => entry.name);
  expect(new Set(names).size).toBe(names.length);
  expect([...names].sort()).toEqual([...SHOWN].sort());
});

test("each announcement carries what the server requires: a name, a title, a kind and a description", () => {
  for (const entry of ANNOUNCED) {
    expect(entry.title.trim()).not.toBe("");
    expect(entry.description.trim()).not.toBe("");
    expect(["chart", "card"]).toContain(entry.kind);
  }
});
