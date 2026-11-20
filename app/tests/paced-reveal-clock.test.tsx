import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  FINISH_MS,
  nextReveal,
  usePacedReveal,
} from "@/components/channels/paced-reveal";
import { settleReactWork } from "./settle-react-work";

/**
 * Tokens arrive every 10 to 20ms, between frames. Each used to restart the reveal's frame loop and
 * its clock, so the next frame measured the few ms since the token rather than the ~16ms since the
 * last frame, and the reveal ran at a fraction of its pace. Driven here by hand: a frame every 16ms,
 * a token 10ms into each.
 */

let now = 0;
let queue: FrameRequestCallback[] = [];
const real = {
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
  now: performance.now.bind(performance),
};

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  window.requestAnimationFrame = (callback) => {
    queue.push(callback);
    return queue.length;
  };
  window.cancelAnimationFrame = (id) => {
    queue[id - 1] = () => {};
  };
  performance.now = () => now;
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  window.requestAnimationFrame = real.raf;
  window.cancelAnimationFrame = real.caf;
  performance.now = real.now;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function frame() {
  const callbacks = queue;
  queue = [];
  act(() => {
    for (const callback of callbacks) callback(now);
  });
}

test("a reply keeps its pace while tokens arrive between frames", () => {
  let text = Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ");
  const start = text.length;
  const { result, rerender } = renderHook(
    ({ value }) => usePacedReveal(value, { live: true, streaming: true }),
    { initialProps: { value: text } },
  );

  // 400ms: the catch-up budget for the backlog that was there at the start.
  for (let index = 0; index < 25; index++) {
    now += 10;
    text += ` t${index}`;
    rerender({ value: text });
    now += 6;
    frame();
  }

  // What the same frames reveal when each one counts its full 16ms.
  let ideal = 0;
  let grown = Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ");
  for (let index = 0; index < 25; index++) {
    grown += ` t${index}`;
    ideal = nextReveal({
      text: grown,
      shown: ideal,
      elapsedMs: 16,
      streaming: true,
      finishInMs: FINISH_MS,
    });
  }
  expect(ideal).toBeGreaterThan(start / 2);
  expect(result.current.length).toBeGreaterThanOrEqual(ideal * 0.95);
});
