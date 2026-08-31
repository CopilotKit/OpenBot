import { describe, expect, test } from "bun:test";
import { chooseLivePage } from "../src/live-page";

// A popup OAuth sign-in is the case this exists for: the page a Bot was pinned to at launch is not
// the page the person taking the wheel needs to see, and the popup closes itself when it succeeds.
const page = (closed = false) => ({ isClosed: () => closed });

describe("choosing the page a Bot is on", () => {
  test("one page is that page", () => {
    const only = page();
    expect(chooseLivePage([only])).toBe(only);
  });

  test("a window the site opens becomes the live one", () => {
    const opener = page();
    const popup = page();
    expect(chooseLivePage([opener, popup])).toBe(popup);
  });

  test("closing that window falls back to the opener", () => {
    const opener = page();
    const popup = page(true);
    expect(chooseLivePage([opener, popup])).toBe(opener);
  });

  test("a closed opener is not chosen while another page is open", () => {
    const opener = page(true);
    const popup = page();
    expect(chooseLivePage([opener, popup])).toBe(popup);
  });

  test("nothing open is nothing to choose", () => {
    expect(chooseLivePage([page(true), page(true)])).toBeUndefined();
    expect(chooseLivePage([])).toBeUndefined();
  });
});
