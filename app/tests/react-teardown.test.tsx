import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { render } from "@testing-library/react";
import { useEffect, useState } from "react";

/**
 * A file that takes its document away while React still has work posted.
 *
 * main's CI went red with every test passing: React's scheduler ran a render after a file's
 * `afterAll` had unregistered happy-dom, read `window.event` from a window that was gone, and bun
 * reported it as an unhandled error between files. react-teardown.ts, loaded by the preload, makes
 * `unregister()` run that work first, whether or not the file waits for it. Without it, this test
 * sees the render never happen before the document goes, and then the same error.
 */
test("work React posted before a file's document goes runs while the document is still there", async () => {
  GlobalRegistrator.register();
  try {
    const committed: number[] = [];
    let unmounted = false;
    let bump = () => {};
    function Counter() {
      const [count, setCount] = useState(0);
      bump = () => setCount((value) => value + 1);
      useEffect(() => {
        committed.push(count);
      }, [count]);
      useEffect(
        () => () => {
          unmounted = true;
        },
        [],
      );
      return <p>{count}</p>;
    }
    // Rendered and never cleaned up, as a file that forgets `cleanup` leaves its screen.
    render(<Counter />);
    expect(committed).toEqual([0]);

    // Outside act, as a response or a timer updates a screen while a `waitFor` polls (which turns
    // the act environment off for as long as it waits). React schedules the render from a microtask,
    // so once one has passed it is posted to the scheduler and waiting for its turn.
    const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    try {
      bump();
      await Promise.resolve();
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    }

    // Not awaited, as most files call it, and before the scheduler has had a turn.
    void GlobalRegistrator.unregister();
    expect(GlobalRegistrator.isRegistered).toBe(false);
    expect(committed).toEqual([0, 1]);
    // The screen it left mounted came down with it, so nothing on it can schedule more.
    expect(unmounted).toBe(true);

    // And nothing is left to run against the missing window.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  }
});
