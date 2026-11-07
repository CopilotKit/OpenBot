import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePacedReveal } from "@/components/channels/paced-reveal";
import { settleReactWork } from "./settle-react-work";

/**
 * A covered window draws no frames. WebKit stops `requestAnimationFrame` for a window another one
 * covers (OpenBot Desktop behind the person's other apps), and browsers do the same for a hidden
 * tab. The reveal ran only on frames, so a reply that arrived while the window was covered stayed
 * half drawn, or not drawn at all, until somebody looked at it: a screen reader, a notification
 * or a glance at the window all read the cut-off text. Here no frame ever comes.
 */

const real = {
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
};

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  window.requestAnimationFrame = () => 1;
  window.cancelAnimationFrame = () => {};
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  window.requestAnimationFrame = real.raf;
  window.cancelAnimationFrame = real.caf;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a reply that arrives while the window draws no frames is still drawn whole", async () => {
  const text =
    "Done — the RSVP was submitted successfully. Summary of what was submitted: Full name: Dana Whitfield, Email: dana.whitfield@example.com, Meal: Vegetarian.";
  const { result } = renderHook(() =>
    usePacedReveal(text, { live: true, streaming: false }),
  );
  await waitFor(() => expect(result.current).toBe(text), { timeout: 3000 });
});

test("a reply still streaming keeps moving with no frames, and ends whole", async () => {
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
  const { result, rerender } = renderHook(
    ({ value, streaming }) => usePacedReveal(value, { live: true, streaming }),
    { initialProps: { value: words.slice(0, 30).join(" "), streaming: true } },
  );
  await waitFor(() => expect(result.current.length).toBeGreaterThan(0), {
    timeout: 2000,
  });
  rerender({ value: words.join(" "), streaming: false });
  await waitFor(() => expect(result.current).toBe(words.join(" ")), {
    timeout: 3000,
  });
});
