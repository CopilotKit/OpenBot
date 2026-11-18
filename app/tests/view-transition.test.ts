import { afterEach, describe, expect, mock, test } from "bun:test";
import { crossFade, pageTransitionTypes } from "@/lib/view-transition";

/*
 * Whole-app changes as one movement (lib/view-transition.ts): a page change cross-fades the page, and
 * a theme or skin change cross-fades the app, except where the browser cannot or the person asked
 * for less motion, where the change simply happens.
 */

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

function browser({
  reducedMotion = false,
  startViewTransition,
}: {
  reducedMotion?: boolean;
  startViewTransition?: (update: () => void) => unknown;
}) {
  globalThis.window = {
    matchMedia: (query: string) => ({
      matches: reducedMotion && query.includes("reduce"),
    }),
  } as unknown as typeof window;
  globalThis.document = {
    ...(startViewTransition ? { startViewTransition } : {}),
  } as unknown as Document;
}

describe("which page changes the router draws as a transition", () => {
  test("going to another page is a page transition", () => {
    browser({});
    expect(
      pageTransitionTypes({ fromLocation: {}, pathChanged: true }),
    ).toEqual(["page"]);
  });

  test("never the first page drawn, nor a change to the address's options alone", () => {
    browser({});
    expect(pageTransitionTypes({ pathChanged: true })).toBe(false);
    expect(pageTransitionTypes({ fromLocation: {}, pathChanged: false })).toBe(
      false,
    );
  });

  test("never for somebody who asked for less motion", () => {
    browser({ reducedMotion: true });
    expect(pageTransitionTypes({ fromLocation: {}, pathChanged: true })).toBe(
      false,
    );
  });
});

describe("a whole-app change", () => {
  test("cross-fades where the browser can, with the change made inside the transition", () => {
    const order: string[] = [];
    browser({
      startViewTransition: (update) => {
        order.push("picture");
        update();
        return {};
      },
    });
    crossFade(() => order.push("change"));
    expect(order).toEqual(["picture", "change"]);
  });

  test("simply happens where the browser cannot, or for somebody who asked for less motion", () => {
    const change = mock(() => {});
    browser({});
    crossFade(change);
    const start = mock(() => ({}));
    browser({ reducedMotion: true, startViewTransition: start });
    crossFade(change);
    expect(change).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });
});
