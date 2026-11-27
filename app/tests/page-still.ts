import type { Page } from "playwright-core";

/**
 * Until nothing on the page is moving, for the browser tests that measure or photograph a screen.
 *
 * Those tests draw the page first and add its stylesheet after, so the styles arrive on elements
 * already drawn and start the transitions they declare: a dialog slides from where it sat unstyled
 * to the middle of the window, a button fades from the browser's own colour to its own, rows ease
 * in. Styled, a row that measures itself lays out again, and what it draws then may move too. A
 * fixed wait (a `waitForTimeout` of 400ms) guessed how long that takes, and under a full CI run
 * (eight files at once, Chromium and WebKit each) it sometimes guessed short, so the test read the
 * screen mid-move and failed. This waits for the page itself to say it is done instead.
 *
 * Still means, for three frames in a row: no animation or transition that ends is running, and no
 * element's box (where it is laid out, and its size) has changed. Endless animations (a spinner, a
 * shimmer) and ones driven by scrolling (the transcript's scroll fade) never end on their own, so
 * they do not count; waiting on a scroll-driven one's `finished` never returns, because its
 * timeline is the scroller, not time. Boxes are read as laid out, before transforms, so an orb that
 * breathes by scaling itself every frame does not keep the page from being still. A page that never
 * stops fails here, saying what kept moving, rather than being measured mid-move.
 */
export async function still(page: Page, timeout = 10_000): Promise<void> {
  const moving = await page.evaluate(async (timeout) => {
    // A font that lands lays the text out again.
    await document.fonts.ready;
    const frame = () =>
      new Promise<void>((done) => requestAnimationFrame(() => done()));
    const name = (node: Element | null) => {
      if (!node) return "nothing";
      const classes = [...node.classList].slice(0, 3).join(".");
      return classes ? `${node.localName}.${classes}` : node.localName;
    };
    const running = () =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.timeline === document.timeline &&
            Number.isFinite(
              Number(animation.effect?.getComputedTiming().endTime),
            ),
        );
    /** Every element's laid-out box, in document order. */
    const boxes = () =>
      [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => element instanceof HTMLElement)
        .map(
          (element) =>
            [
              element,
              `${element.offsetLeft},${element.offsetTop},${element.offsetWidth},${element.offsetHeight}`,
            ] as const,
        );
    /** The first element whose box is not where it was, or null when none moved. */
    const moved = (
      before: ReturnType<typeof boxes>,
      now: ReturnType<typeof boxes>,
    ): string | null => {
      if (before.length !== now.length)
        return `elements came or went (${before.length} then ${now.length})`;
      const index = now.findIndex(
        ([element, box], at) =>
          before[at]?.[0] !== element || before[at]?.[1] !== box,
      );
      if (index < 0) return null;
      const [element, box] = now[index] as (typeof now)[number];
      return `${name(element)} moved from ${before[index]?.[1]} to ${box}`;
    };
    const deadline = performance.now() + timeout;
    let last = boxes();
    for (let quiet = 0; quiet < 3; ) {
      await frame();
      const now = running();
      const laid = boxes();
      const shift = moved(last, laid);
      last = laid;
      if (now.length === 0 && shift === null) {
        quiet += 1;
        continue;
      }
      quiet = 0;
      if (performance.now() > deadline)
        return [
          ...now.map((animation) => {
            const target =
              animation.effect instanceof KeyframeEffect
                ? animation.effect.target
                : null;
            const what =
              animation instanceof CSSTransition
                ? `a transition of ${animation.transitionProperty}`
                : animation instanceof CSSAnimation
                  ? `the animation ${animation.animationName}`
                  : "an animation";
            return `${what} on ${name(target)}`;
          }),
          ...(shift ? [shift] : []),
        ].join(", ");
    }
    return null;
  }, timeout);
  if (moving)
    throw new Error(
      `The page was still moving after ${timeout}ms: ${moving}. Something on it never stops, so there is no still screen to measure.`,
    );
}
