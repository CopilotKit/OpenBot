import { type RefObject, useLayoutEffect, useState } from "react";

/** What `fittedWidth` works from, every number measured from what is on screen at the frame's current width. */
export type FitMeasure = {
  /** The space the frame has: its width and height inside its padding. */
  space: { width: number; height: number };
  /** The frame's width. */
  frameWidth: number;
  /** The page's width: the browser's page spans it, at the browser's shape. Less than `frameWidth` by a border. */
  pageWidth: number;
  /** How much of the frame's height has to fit the space, the page's included. Everything else in it is bars. */
  fittedHeight: number;
};

/**
 * The frame's width at which its page, drawn at `ratio` (width over height), fills it and the part that has to fit
 * (`fittedHeight`) fits the space: as wide as the space allows while the bars above and below the page still fit its
 * height. The bars are what the frame holds besides the page, measured at its current width; they don't scale with it.
 *
 * `minWidth` is a floor, never wider than the space. Fitting a short space can otherwise spiral: a narrower frame wraps
 * more of what is above and below its page, which takes more height and narrows it again, until the page is too small
 * to use. Narrowing only ever wraps more, so the width settles rather than flipping between two; the floor stops it
 * settling too small, and the space scrolls instead.
 */
export function fittedWidth(
  { space, frameWidth, pageWidth, fittedHeight }: FitMeasure,
  ratio: number,
  minWidth = 0,
): number {
  const beside = frameWidth - pageWidth;
  const bars = fittedHeight - pageWidth / ratio;
  const page = Math.min(space.width - beside, (space.height - bars) * ratio);
  const floor = Math.min(minWidth, Math.floor(space.width));
  return Math.max(0, floor, Math.floor(page + beside));
}

/**
 * The width at which a browser window shows its whole page with nothing blank inside it (`fittedWidth`).
 *
 * The browser behind the window has a fixed shape (`ratio`), so its page is drawn at that shape. A window that simply
 * took the space it was given left a blank band under the page, or beside it, in any space of another shape. Here the
 * window is as wide as `area` allows while it still fits `area`'s height, so the page fills the window and whatever
 * space is left is outside it.
 *
 * `frame` is what is sized. By default it is the window itself: its page spans its full inner width, and the rest of
 * its height is its bars (tabs, toolbar, a notice, a status bar). `page` names the window inside a larger frame (a
 * column with a heading above the window), and the frame then has to fit only down to the window's bottom edge.
 * `below` is a part of the frame under the window that takes whatever height is left: it counts only at its CSS
 * `min-height`, so how much it holds never changes the window's size. Everything is measured rather than assumed,
 * because what the bars hold changes and a toolbar wraps on a narrow screen (and per openbot-screen-layout, a size is
 * measured, never taken from a Tailwind token).
 *
 * Undefined until the first measurement, and where nothing is laid out (a test's DOM), so the frame falls back to its
 * full width there. `shown` says whether the window is drawn at all, so measuring starts when it appears.
 */
export function useFittedWidth(
  area: RefObject<HTMLElement | null>,
  frame: RefObject<HTMLElement | null>,
  ratio: number,
  {
    shown = true,
    minWidth = 0,
    page,
    below,
  }: {
    shown?: boolean;
    minWidth?: number;
    page?: RefObject<HTMLElement | null>;
    below?: RefObject<HTMLElement | null>;
  } = {},
): number | undefined {
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const outer = area.current;
    const inner = frame.current;
    if (!shown || !outer || !inner || typeof ResizeObserver === "undefined")
      return;
    const fit = () => {
      // The window the page fills: the frame itself, unless it is a column with the window inside it.
      const browser = page?.current ?? inner;
      const style = getComputedStyle(outer);
      const space = {
        width:
          outer.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight),
        height:
          outer.clientHeight -
          Number.parseFloat(style.paddingTop) -
          Number.parseFloat(style.paddingBottom),
      };
      if (space.width <= 0 || space.height <= 0 || browser.clientWidth <= 0)
        return;
      let fittedHeight = inner.offsetHeight;
      if (browser !== inner) {
        const top = inner.getBoundingClientRect().top;
        const bottom = browser.getBoundingClientRect().bottom;
        fittedHeight = bottom - top;
        const under = below?.current;
        if (under)
          fittedHeight +=
            under.getBoundingClientRect().top -
            bottom +
            (Number.parseFloat(getComputedStyle(under).minHeight) || 0);
      }
      const next = fittedWidth(
        {
          space,
          frameWidth: inner.offsetWidth,
          pageWidth: browser.clientWidth,
          fittedHeight,
        },
        ratio,
        minWidth,
      );
      setWidth((current) => (current === next ? current : next));
    };
    const observer = new ResizeObserver(fit);
    // The window and what is under it too: in a frame of fixed height, a notice in the window changes only those.
    for (const element of [outer, inner, page?.current, below?.current])
      if (element) observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [area, frame, ratio, shown, minWidth, page, below]);
  return width;
}
