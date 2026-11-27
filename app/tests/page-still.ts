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
 * Still means, for three frames in a row: no animation or transition that ends is running, and
 * nothing in the document changed. Endless animations (a spinner, a shimmer) and ones driven by
 * scrolling (the transcript's scroll fade) never end on their own, so they do not count; waiting on
 * a scroll-driven one's `finished` never returns, because its timeline is the scroller, not time.
 * A page that never stops fails here, saying what kept moving, rather than being measured mid-move.
 */
export async function still(page: Page, timeout = 10_000): Promise<void> {
  const moving = await page.evaluate(async (timeout) => {
    // A font that lands lays the text out again.
    await document.fonts.ready;
    const frame = () =>
      new Promise<void>((done) => requestAnimationFrame(() => done()));
    const name = (node: Node | null) => {
      if (!(node instanceof Element)) return node?.nodeName ?? "nothing";
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
    let changed: Node | null = null;
    const watcher = new MutationObserver((records) => {
      changed = records.at(-1)?.target ?? document;
    });
    /** What changed since the last frame, if anything; and forget it. */
    const take = (): Node | null => {
      const was = changed;
      changed = null;
      return was;
    };
    watcher.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const deadline = performance.now() + timeout;
    try {
      for (let quiet = 0; quiet < 3; ) {
        await frame();
        const now = running();
        const touched = take();
        if (now.length === 0 && touched === null) {
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
                  ? `transition of ${animation.transitionProperty}`
                  : animation instanceof CSSAnimation
                    ? `animation ${animation.animationName}`
                    : "animation";
              return `${what} on ${name(target)}`;
            }),
            ...(touched ? [`a change to ${name(touched)}`] : []),
          ].join(", ");
      }
      return null;
    } finally {
      watcher.disconnect();
    }
  }, timeout);
  if (moving)
    throw new Error(
      `The page was still moving after ${timeout}ms: ${moving}. Something on it never stops, so there is no still screen to measure.`,
    );
}
