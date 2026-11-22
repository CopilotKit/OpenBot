import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutWatch } from "./useLayoutWatch";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

type Watch = ReturnType<typeof useLayoutWatch>;

/** A booted window in `frame`, with a clock that the test moves. */
function fakeWindow(frame: HTMLIFrameElement) {
  const ticks = new Set<() => void>();
  const clock = {
    at: 0,
    now: () => clock.at,
    onTick(listener: () => void) {
      ticks.add(listener);
      return () => ticks.delete(listener);
    },
  };
  Object.assign(frame.contentWindow as object, {
    __workbenchClock: clock,
    __workbench: { onChange: () => () => {} },
    __workbenchBooted: true,
  });
  /** Moves the clock and lets the watch check on the next animation frame. */
  const tick = async (at: number) => {
    clock.at = at;
    for (const listener of ticks) listener();
    await act(() => new Promise((done) => setTimeout(done, 40)));
  };
  return { ticks, tick };
}

function frame(): HTMLIFrameElement {
  const element = document.createElement("iframe");
  document.body.append(element);
  return element;
}

function watchOf(element: HTMLIFrameElement | null) {
  const seen: { current: Watch | null } = { current: null };
  function Probe({ frame }: { frame: HTMLIFrameElement | null }) {
    seen.current = useLayoutWatch(frame, { width: 800, height: 600 });
    return null;
  }
  const view = render(<Probe frame={element} />);
  return {
    seen,
    rerender: (next: HTMLIFrameElement | null) =>
      view.rerender(<Probe frame={next} />),
  };
}

test("checkedAt is the time of the window's last check", async () => {
  const element = frame();
  const { tick } = fakeWindow(element);
  const { seen } = watchOf(element);
  await act(() => new Promise((done) => setTimeout(done, 40)));
  await tick(5000);
  expect(seen.current?.checkedAt).toBe(5000);
});

// A seek back puts a new iframe in place. Its warnings start empty, and checkedAt must start at 0
// with them: the page merges the old rows at that time, and a merge at the old window's time
// dropped every row, so the list showed none.
test("a new window starts again from no warnings at time 0", async () => {
  const first = frame();
  const old = fakeWindow(first);
  const { seen, rerender } = watchOf(first);
  await act(() => new Promise((done) => setTimeout(done, 40)));
  await old.tick(60_000);
  expect(seen.current?.checkedAt).toBe(60_000);

  const second = frame();
  fakeWindow(second);
  await act(async () => rerender(second));
  expect(seen.current?.warnings).toEqual([]);
  expect(seen.current?.checkedAt).toBe(0);
  // The old window's clock is no longer watched.
  expect(old.ticks.size).toBe(0);
});

test("a load of the same iframe again is watched from the start", async () => {
  const element = frame();
  const before = fakeWindow(element);
  const { seen } = watchOf(element);
  await act(() => new Promise((done) => setTimeout(done, 40)));
  await before.tick(30_000);
  expect(seen.current?.checkedAt).toBe(30_000);

  // The reloaded window: a new clock from 0, as the boot script sets it up.
  const after = fakeWindow(element);
  await act(async () => {
    element.dispatchEvent(new Event("load"));
  });
  expect(seen.current?.checkedAt).toBe(0);
  expect(before.ticks.size).toBe(0);
  await act(() => new Promise((done) => setTimeout(done, 40)));
  expect(after.ticks.size).toBe(1);
  await after.tick(2000);
  expect(seen.current?.checkedAt).toBe(2000);
});
