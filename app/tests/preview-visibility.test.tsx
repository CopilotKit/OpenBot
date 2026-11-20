import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useElementVisible } from "../src/components/computer/preview-visibility";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;

/** An observer the test fires by hand, as the browser would. */
function fakeObserver() {
  const callbacks: Callback[] = [];
  const original = window.IntersectionObserver;
  window.IntersectionObserver = class {
    constructor(callback: Callback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  return {
    fire: (entries: Partial<IntersectionObserverEntry>[]) =>
      act(() => callbacks.at(-1)?.(entries)),
    restore: () => {
      window.IntersectionObserver = original;
    },
  };
}

test("an element that slid into view during one batch counts as visible", () => {
  // A panel animating open reports the frame it started off-screen and the frame it arrived in
  // together. The newest entry is the element as it is now; the first one is history.
  const observer = fakeObserver();
  try {
    const { result } = renderHook(() => useElementVisible<HTMLElement>());
    act(() => result.current[0](document.createElement("figure")));
    observer.fire([{ isIntersecting: false }, { isIntersecting: true }]);
    expect(result.current[1]).toBe(true);
  } finally {
    observer.restore();
  }
});

test("an element that left view during one batch counts as hidden", () => {
  const observer = fakeObserver();
  try {
    const { result } = renderHook(() => useElementVisible<HTMLElement>());
    act(() => result.current[0](document.createElement("figure")));
    observer.fire([{ isIntersecting: true }, { isIntersecting: false }]);
    expect(result.current[1]).toBe(false);
  } finally {
    observer.restore();
  }
});
