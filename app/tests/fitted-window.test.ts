import { expect, test } from "bun:test";
import {
  type FitMeasure,
  fittedWidth,
} from "@/components/browser/fitted-window";

/**
 * The maths that sizes a browser window to its page (`useFittedWidth` measures; `fittedWidth` decides). The browser
 * behind the window is a fixed 1280 by 800, so its page is drawn at 1.6 wide to 1 high, and the window is as wide as
 * its space allows while its bars and its page fit the space's height.
 */

const RATIO = 1280 / 800;

/** A window with a 1px border each side and `bars` of height besides its page, measured at `width`. */
function windowAt(
  space: { width: number; height: number },
  width: number,
  bars: number,
): FitMeasure {
  const pageWidth = width - 2;
  return {
    space,
    frameWidth: width,
    pageWidth,
    fittedHeight: bars + pageWidth / RATIO,
  };
}

test("in a space wider than the page's shape, the window is as tall as the space and its page fills it", () => {
  // 600 high less 100 of bars leaves 500 for the page, so it is 800 wide, and the window 2 more for its border.
  expect(
    fittedWidth(windowAt({ width: 1000, height: 600 }, 1000, 100), RATIO),
  ).toBe(802);
});

test("in a space narrower than the page's shape, the window is as wide as the space", () => {
  expect(
    fittedWidth(windowAt({ width: 700, height: 900 }, 700, 100), RATIO),
  ).toBe(700);
});

test("the answer depends on the bars, not on how wide the window was when they were measured", () => {
  const space = { width: 1000, height: 600 };
  expect(fittedWidth(windowAt(space, 402, 100), RATIO)).toBe(802);
  expect(fittedWidth(windowAt(space, 1000, 100), RATIO)).toBe(802);
});

test("more bars make the window narrower, so the whole of it still fits the space's height", () => {
  const space = { width: 1000, height: 600 };
  expect(fittedWidth(windowAt(space, 802, 180), RATIO)).toBe(674);
});

test("a short space stops at the floor, and the space scrolls instead", () => {
  const short = { width: 1000, height: 300 };
  expect(fittedWidth(windowAt(short, 1000, 100), RATIO)).toBe(322);
  expect(fittedWidth(windowAt(short, 1000, 100), RATIO, 640)).toBe(640);
});

test("the floor is never wider than the space", () => {
  expect(
    fittedWidth(windowAt({ width: 500, height: 300 }, 500, 100), RATIO, 640),
  ).toBe(500);
});

test("a space with no room for the page gives no width, never a negative one", () => {
  expect(
    fittedWidth(windowAt({ width: 300, height: 50 }, 300, 100), RATIO),
  ).toBe(0);
});

test("a heading that wraps as the window narrows settles on one width, and the floor keeps it usable", () => {
  // A heading that takes a second line below 700 wide: the bars grow as the window narrows.
  const bars = (width: number) => (width < 700 ? 140 : 100);
  const settle = (space: { width: number; height: number }, floor = 0) => {
    let width = space.width;
    for (let pass = 0; pass < 10; pass++) {
      const next = fittedWidth(
        windowAt(space, width, bars(width)),
        RATIO,
        floor,
      );
      if (next === width) return width;
      width = next;
    }
    throw new Error("never settled");
  };
  expect(settle({ width: 1000, height: 560 })).toBe(738);
  expect(settle({ width: 1000, height: 530 })).toBe(626);
  expect(settle({ width: 1000, height: 530 }, 640)).toBe(640);
});
