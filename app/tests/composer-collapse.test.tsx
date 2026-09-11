import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { Suspense, startTransition, use, useState } from "react";
import { Collapse } from "@/components/channels/composer/collapse";

/**
 * WHEN THE BOX MEASURES THE THING IT IS ABOUT TO ANIMATE, AND WHEN IT REFUSES TO.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `agent-roster-error.test.tsx`: bun walks every file into one process, and a
 * document another file tore down mid-run fails invisibly. The registration carries a `url` for the
 * reason `composer-attachments-ui.test.tsx` records.
 *
 * WHY THESE TESTS WATCH THE MEASUREMENT RATHER THAN THE HEIGHT ON SCREEN. There is no height on
 * screen to watch. `motion` binds its frame loop at import time, and every module in this suite is
 * imported before `GlobalRegistrator.register()` has put a `window` in the world, so motion's
 * animated values are never written to the DOM here: the box reports `height: 0px` forever no
 * matter what it was told to animate to. What IS observable is the only thing this component reads
 * from the DOM — `offsetHeight` on the content — and reading it is not incidental, it is the whole
 * act of taking a measurement. Counting those reads is counting the decisions the component made.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

/** Every `offsetHeight` the component read since the last reset. */
let measurements = 0;
/** The callbacks the component handed to `ResizeObserver`, for the test to fire on cue. */
let observers: (() => void)[] = [];

/**
 * happy-dom has no layout engine, so `offsetHeight` is 0 for everything and a real `ResizeObserver`
 * never fires. Both are stubbed rather than worked around: the height so a measurement is
 * distinguishable from the absence of one, and the observer so the test says exactly when it
 * arrives instead of hoping.
 */
function installMeasurementProbe() {
  measurements = 0;
  observers = [];

  const height = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      measurements += 1;
      return 64;
    },
  });

  const realObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      observers.push(callback);
    }
    disconnect() {}
    observe() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;

  return () => {
    if (height)
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
    globalThis.ResizeObserver = realObserver;
  };
}

/** A promise that never settles: anything that reads it suspends and stays suspended. */
const pending = new Promise<void>(() => {});

function Blocker() {
  use(pending);
  return null;
}

test("the observer is refused while the box is closed", () => {
  // The guard this component is built around, stated on its own so the two tests below cannot pass
  // by having removed it. A caller may unmount its content on the way closed — `RejectedFiles`
  // does, because a `role="alert"` left in the tree is still an alert — and the observer fires for
  // that. Taking THAT measurement would overwrite the height we are animating FROM with the zero
  // we are animating TO, and the close would have nothing to travel.
  const restore = installMeasurementProbe();

  try {
    const { rerender } = render(
      <Collapse open={true}>
        <div>content</div>
      </Collapse>,
    );

    rerender(<Collapse open={false}>{null}</Collapse>);
    measurements = 0;
    for (const fire of observers) fire();

    expect(measurements).toBe(0);
  } finally {
    restore();
  }
});

test("a render that never commits does not close the guard", async () => {
  // THE DEFECT: the guard's ref was assigned during render (`isOpen.current = open`), so it
  // recorded what React was CONSIDERING rather than what React had committed.
  //
  // React is allowed to render a component and throw the work away. That is not exotic — it is
  // what every interrupted or suspended transition does. Below, closing the box is wrapped in a
  // transition that suspends, so React renders `Collapse` with `open={false}` and then abandons
  // the attempt: the content is still mounted, the box is still open, and nothing on screen has
  // moved. A ref written during render has already been told otherwise.
  //
  // The observer then fires for a real change to the still-open content, and the poisoned guard
  // turns it away — the box goes on animating to a height its content no longer has.
  const restore = installMeasurementProbe();
  let close = () => {};

  function Harness() {
    const [open, setOpen] = useState(true);
    close = () => startTransition(() => setOpen(false));

    return (
      <>
        <Collapse open={open}>
          <div>content</div>
        </Collapse>
        <Suspense fallback={<span>waiting</span>}>
          {open ? null : <Blocker />}
        </Suspense>
      </>
    );
  }

  try {
    const { container } = render(<Harness />);

    await act(async () => {
      close();
    });

    // The transition never landed: what is on screen is still the open box with its content.
    expect(container.textContent).toBe("content");

    measurements = 0;
    await act(async () => {
      for (const fire of observers) fire();
    });

    expect(measurements).toBeGreaterThan(0);
  } finally {
    restore();
  }
});

test("opening measures the content in the commit that opened it", () => {
  // THE DEFECT: `openHeight` starts at 0 and nothing but the `ResizeObserver` ever moved it. On
  // the very first open there has been no measurement to move it with — the observer's own first
  // callback landed while the box was still closed, and the guard above correctly refused it — so
  // the first `open` flipped `animate` from a height of 0 to a height of 0. The real height only
  // arrived on the frame after, once the observer had fired again and its `setState` had landed.
  //
  // Nobody sees an animation there. They see the composer sit still for a frame and then jump,
  // which is the exact hitch this component exists to remove, on the first attachment of every
  // session.
  //
  // The observer is stubbed to silence below, which is the point: with nothing firing it, the only
  // way the content gets measured is if opening measures it. Before this was fixed, no measurement
  // was ever taken and the strip animated to nothing.
  const restore = installMeasurementProbe();

  try {
    const { rerender } = render(
      <Collapse open={false}>
        <div>content</div>
      </Collapse>,
    );

    measurements = 0;
    rerender(
      <Collapse open={true}>
        <div>content</div>
      </Collapse>,
    );

    expect(measurements).toBeGreaterThan(0);
  } finally {
    restore();
  }
});

test("every later open measures again, not just the first", () => {
  // The narrowest fix for the test above would be to measure once, on mount, and that would leave
  // the second attachment of a session animating to the height of the first. A composer opens and
  // closes this box all day, and what goes in it is a different size every time.
  const restore = installMeasurementProbe();

  try {
    const { rerender } = render(
      <Collapse open={false}>
        <div>content</div>
      </Collapse>,
    );

    rerender(
      <Collapse open={true}>
        <div>content</div>
      </Collapse>,
    );
    rerender(<Collapse open={false}>{null}</Collapse>);

    measurements = 0;
    rerender(
      <Collapse open={true}>
        <div>a taller thing</div>
      </Collapse>,
    );

    expect(measurements).toBeGreaterThan(0);
  } finally {
    restore();
  }
});
