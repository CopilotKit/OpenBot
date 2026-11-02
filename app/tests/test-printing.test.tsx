import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { queryClient } from "@/query-client";

/**
 * A rendered element in a failed assertion is printed as its markup, at once (app/tests/preload.ts).
 *
 * Bun printed it by walking everything it reached, React's fiber and the window's globals among it, synchronously: one
 * failed `expect(dialog).toBeNull()` in a `waitFor` held the event loop for 3.3 s locally and 8.8 s on GitHub's runner,
 * where recorder-browsers.test.tsx then timed out. The time is not asserted closely, a runner's speed is not this test's
 * to pin; what is printed is, and it is what made the time.
 */
beforeAll(() => GlobalRegistrator.register());
afterAll(() => {
  cleanup();
  GlobalRegistrator.unregister();
});

test("a failed assertion on a rendered element prints its markup, not everything it reaches", () => {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <div aria-label="Disconnect Chrome on Mac?" role="dialog">
        <button type="button">Disconnect</button>
      </div>
    </QueryClientProvider>,
  );
  const dialog = view.getByRole("dialog");
  const started = performance.now();
  let printed = "";
  try {
    expect(dialog).toBeNull();
  } catch (error) {
    printed = error instanceof Error ? error.message : String(error);
  }
  expect(printed).toContain(
    '<div aria-label="Disconnect Chrome on Mac?" role="dialog"><button type="button">Disconnect</button></div>',
  );
  expect(printed).not.toContain("__reactFiber");
  expect(printed).not.toContain("onpointerlockerror");
  expect(performance.now() - started).toBeLessThan(1_000);
});
