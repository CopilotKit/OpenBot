import { describe, expect, test } from "bun:test";
import {
  startVirtualDisplay,
  type DisplayProcess,
  type DisplayRuntime,
} from "../src/virtual-display";

function displayRuntime(ready: boolean) {
  let stopped = false;
  let finish = (_code: number) => {};
  const process: DisplayProcess = {
    exited: new Promise<number>((resolve) => {
      finish = resolve;
    }),
    kill: () => {
      stopped = true;
      finish(0);
      return true;
    },
  };
  const runtime: DisplayRuntime = {
    spawn: () => process,
    ready: async () => ready,
    wait: async () => {},
  };
  return { runtime, stopped: () => stopped };
}

describe("the virtual display behind a full browser", () => {
  test("does not start for the existing headless mode", async () => {
    const fake = displayRuntime(true);
    expect(await startVirtualDisplay("headless", fake.runtime)).toBeNull();
    expect(fake.stopped()).toBe(false);
  });

  test("stays alive for headed Chromium and stops with the computer", async () => {
    const fake = displayRuntime(true);
    const display = await startVirtualDisplay("headed", fake.runtime);

    expect(display?.name).toBe(":99");
    expect(fake.stopped()).toBe(false);
    await display?.stop();
    expect(fake.stopped()).toBe(true);
  });

  test("refuses to launch Chromium when the display never becomes ready", async () => {
    const fake = displayRuntime(false);
    await expect(startVirtualDisplay("headed", fake.runtime)).rejects.toThrow(
      "The virtual display did not become ready",
    );
    expect(fake.stopped()).toBe(true);
  });
});
