import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * The width at which a browser window shows its whole page with nothing blank inside it.
 *
 * The browser behind the window has a fixed shape (`ratio`, width over height), so its page is drawn at that shape. A
 * window that simply took the space it was given left a blank band under the page, or beside it, in any space of
 * another shape. Here the window is as wide as `area` allows while the whole window, its bars included, still fits
 * `area`'s height, so the page fills the window and whatever space is left is outside it.
 *
 * `frame` is the window. Its page spans its full inner width at `ratio`, and the rest of its height is its bars: tabs,
 * toolbar, a notice under it, a status bar at its foot. The bars are measured rather than assumed, because what they
 * hold changes and a toolbar wraps on a narrow screen (and per openbot-screen-layout, a size is measured, never taken
 * from a Tailwind token). Undefined until the first measurement, and where nothing is laid out (a test's DOM), so the
 * window falls back to its full width there. `shown` says whether the window is drawn at all, so measuring starts when
 * it appears.
 */
export function useFittedWidth(
  area: RefObject<HTMLElement | null>,
  frame: RefObject<HTMLElement | null>,
  ratio: number,
  shown = true,
): number | undefined {
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const outer = area.current;
    const inner = frame.current;
    if (!shown || !outer || !inner || typeof ResizeObserver === "undefined")
      return;
    const fit = () => {
      const style = getComputedStyle(outer);
      const availableWidth =
        outer.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const availableHeight =
        outer.clientHeight -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom);
      if (availableWidth <= 0 || availableHeight <= 0 || inner.clientWidth <= 0)
        return;
      const border = inner.offsetWidth - inner.clientWidth;
      const bars = inner.offsetHeight - inner.clientWidth / ratio;
      const page = Math.min(
        availableWidth - border,
        (availableHeight - bars) * ratio,
      );
      // Narrowing only ever wraps the toolbar more, so this settles rather than flipping between two widths.
      const next = Math.max(0, Math.floor(page + border));
      setWidth((current) => (current === next ? current : next));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    observer.observe(inner);
    fit();
    return () => observer.disconnect();
  }, [area, frame, ratio, shown]);
  return width;
}
