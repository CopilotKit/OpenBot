import { describe, expect, test } from "bun:test";
import {
  startVirtualDisplay,
  type DisplayProcess,
  type DisplayRuntime,
} from "../src/virtual-display";

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function displayRuntime() {
  const ready = deferred<string>();
  const exited = deferred<number>();
  const readyWait = deferred<void>();
  const stopWait = deferred<void>();
  const killed = deferred<NodeJS.Signals>();
  const forceKilled = deferred<void>();
  const signals: NodeJS.Signals[] = [];
  let waits = 0;
  const process: DisplayProcess = {
    ready: ready.promise,
    exited: exited.promise,
    kill: (signal = "SIGTERM") => {
      signals.push(signal);
      killed.resolve(signal);
      if (signal === "SIGKILL") forceKilled.resolve();
      return true;
    },
  };
  const runtime: DisplayRuntime = {
    spawn: () => process,
    wait: () => (waits++ === 0 ? readyWait.promise : stopWait.promise),
  };
  return {
    runtime,
    ready,
    exited,
    readyWait,
    stopWait,
    killed,
    forceKilled,
    signals,
  };
}

describe("the virtual display behind a full browser", () => {
  test("does not start for the existing headless mode", async () => {
    const fake = displayRuntime();
    expect(await startVirtualDisplay("headless", fake.runtime)).toBeNull();
    expect(fake.signals).toEqual([]);
  });

  test("uses the display allocated by the Xvfb process it owns", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.ready.resolve(":143");
    const display = await starting;

    expect(display?.name).toBe(":143");
    expect(fake.signals).toEqual([]);

    const stopping = display?.stop();
    fake.exited.resolve(0);
    await stopping;
    expect(fake.signals).toEqual(["SIGTERM"]);
    expect(await display?.terminated).toEqual({ code: 0, expected: true });
  });

  test("reports an unexpected exit after the display became ready", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.ready.resolve(":7");
    const display = await starting;

    fake.exited.resolve(23);

    expect(await display?.terminated).toEqual({ code: 23, expected: false });
  });

  test("refuses to launch Chromium when its own display exits before readiness", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.exited.resolve(17);

    await expect(starting).rejects.toThrow(
      "The virtual display exited before it became ready (exit 17)",
    );
    expect(fake.signals).toEqual([]);
  });

  test("stops its display after the readiness deadline", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.readyWait.resolve();
    expect(await fake.killed.promise).toBe("SIGTERM");
    fake.exited.resolve(0);

    await expect(starting).rejects.toThrow(
      "The virtual display did not become ready",
    );
    expect(fake.signals).toEqual(["SIGTERM"]);
  });

  test("force-kills a display that ignores the graceful stop deadline", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.ready.resolve(":8");
    const display = await starting;

    const stopping = display?.stop();
    expect(await fake.killed.promise).toBe("SIGTERM");
    fake.stopWait.resolve();
    await fake.forceKilled.promise;
    fake.exited.resolve(137);
    await stopping;

    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await display?.terminated).toEqual({ code: 137, expected: true });
  });
});
