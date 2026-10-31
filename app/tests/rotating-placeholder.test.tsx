import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRotatingPlaceholder } from "@/hooks/use-rotating-placeholder";

beforeAll(() => GlobalRegistrator.register());

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

afterAll(() => GlobalRegistrator.unregister());

const EXAMPLES = ["First prompt", "Second prompt", "Third prompt"];

test("says 'Ask anything' when there are no examples", () => {
  const { result } = renderHook(() =>
    useRotatingPlaceholder([], { paused: false }),
  );
  expect(result.current).toBe("Ask anything");
});

test("advances once after 3200ms", () => {
  jest.useFakeTimers();
  const { result } = renderHook(() =>
    useRotatingPlaceholder(EXAMPLES, { paused: false }),
  );
  expect(result.current).toBe("First prompt");
  act(() => jest.advanceTimersByTime(3199));
  expect(result.current).toBe("First prompt");
  act(() => jest.advanceTimersByTime(1));
  expect(result.current).toBe("Second prompt");
});

test("holds while paused", () => {
  jest.useFakeTimers();
  const { result } = renderHook(() =>
    useRotatingPlaceholder(EXAMPLES, { paused: true }),
  );
  act(() => jest.advanceTimersByTime(3200 * 3));
  expect(result.current).toBe("First prompt");
});
