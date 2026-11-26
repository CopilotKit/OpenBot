import { beforeEach, expect, test } from "bun:test";
import type { Problem } from "../Problem";
import {
  type Change,
  callNative,
  listenNative,
  nativeControl,
} from "./control";
import { invoke } from "./core";
import { listen } from "./event";

beforeEach(() => nativeControl().reset());

/** Whether `promise` has settled after the current microtasks run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await Bun.sleep(0);
  return done;
}

test("a value answer resolves with that value", async () => {
  nativeControl().setAnswer("default_root", { mode: "value", value: "/x" });
  expect(await invoke<string>("default_root")).toBe("/x");
});

test("a fail answer rejects with the same problem object", async () => {
  const problem: Problem = { said: "It broke." };
  nativeControl().setAnswer("start_stack", { mode: "fail", problem });
  await expect(callNative("start_stack")).rejects.toBe(problem);
});

test("a never answer stays pending", async () => {
  nativeControl().setAnswer("start_stack", { mode: "never" });
  const pending = callNative("start_stack");
  await Bun.sleep(20);
  expect(await settled(pending)).toBe(false);
});

test("a delay answer settles after its time", async () => {
  nativeControl().setAnswer("providers", { mode: "delay", ms: 30, value: 7 });
  const pending = callNative("providers");
  expect(await settled(pending)).toBe(false);
  await Bun.sleep(60);
  expect(await settled(pending)).toBe(true);
  expect(await pending).toBe(7);
});

test("a script answer gets the args and the call number", async () => {
  const seen: unknown[] = [];
  nativeControl().setAnswer("run_local_eval", {
    mode: "script",
    run: (args, call) => {
      seen.push([args, call]);
      return call;
    },
  });
  expect(await callNative("run_local_eval", { action: "start" })).toBe(1);
  expect(await callNative("run_local_eval", { action: "update" })).toBe(2);
  expect(seen).toEqual([
    [{ action: "start" }, 1],
    [{ action: "update" }, 2],
  ]);
});

test("no answer uses the fallback, and without one gives null", async () => {
  expect(await callNative("providers")).toBeNull();
  nativeControl().setFallback((command) => `fallback ${command}`);
  expect(await callNative("providers")).toBe("fallback providers");
});

test("a fallback that throws rejects with the thrown value", async () => {
  const thrown = { said: "No." };
  nativeControl().setFallback(() => {
    throw thrown;
  });
  await expect(callNative("providers")).rejects.toBe(thrown);
});

test("an unknown command is logged as not known", async () => {
  await callNative("no_such_command", { a: 1 });
  await callNative("default_root");
  const calls = nativeControl().calls();
  expect(calls[0]).toMatchObject({
    command: "no_such_command",
    args: { a: 1 },
    known: false,
  });
  expect(calls[1]).toMatchObject({ command: "default_root", known: true });
  expect(typeof calls[0]?.at).toBe("number");
});

test("StrictMode: the first unlisten leaves the second listener", async () => {
  const first: unknown[] = [];
  const second: unknown[] = [];
  const unlisten = await listen<number>("setup:progress", (e) =>
    first.push(e.payload),
  );
  await listen<number>("setup:progress", (e) => second.push(e.payload));
  unlisten();
  nativeControl().emit("setup:progress", 5);
  expect(first).toEqual([]);
  expect(second).toEqual([5]);
  expect(nativeControl().listenerCount("setup:progress")).toBe(1);
});

test("the same handler twice and one unlisten is called once", () => {
  const got: unknown[] = [];
  const handler = (e: { event: string; id: number; payload: unknown }) =>
    got.push(e);
  const unlisten = listenNative("move:progress", handler);
  listenNative("move:progress", handler);
  unlisten();
  unlisten();
  nativeControl().emit("move:progress", "half");
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ event: "move:progress", payload: "half" });
});

test("a value answer settles a call that was waiting", async () => {
  nativeControl().setAnswer("start_stack", { mode: "never" });
  const pending = callNative("start_stack");
  nativeControl().clearAnswer("start_stack");
  expect(await settled(pending)).toBe(false);
  nativeControl().setAnswer("start_stack", { mode: "value", value: "up" });
  expect(await pending).toBe("up");
});

test("onChange hears every call and every emit", async () => {
  const changes: Change[] = [];
  nativeControl().onChange((change) => changes.push(change));
  await callNative("default_root");
  await callNative("providers");
  nativeControl().emit("setup:progress", 1);
  expect(changes.map((c) => c.kind)).toEqual([
    "call",
    "settled",
    "call",
    "settled",
    "emit",
  ]);
  expect(changes[4]).toEqual({
    kind: "emit",
    event: "setup:progress",
    payload: 1,
  });
});

test("__fake keeps the command names and the opened addresses", async () => {
  await callNative("default_root");
  await callNative("plugin:opener|open_url", { url: "https://example.com" });
  expect(globalThis.__fake?.calls).toEqual([
    "default_root",
    "plugin:opener|open_url",
  ]);
  expect(globalThis.__fake?.opened).toEqual(["https://example.com"]);
});

test("a call records how it ended, and a settled change follows the call change", async () => {
  const control = nativeControl();
  const changes: Change[] = [];
  control.onChange((change) => changes.push(change));
  control.setAnswer("default_root", { mode: "value", value: "/x" });
  const promise = callNative("default_root");
  expect(control.calls()[0]?.settled).toBeUndefined();
  await promise;
  expect(control.calls()[0]?.settled).toBe("resolved");
  expect(changes.map((c) => c.kind)).toEqual(["answer", "call", "settled"]);
  expect(changes[2]).toEqual({ kind: "settled", call: control.calls()[0] });
});

test("a fail answer and a throwing fallback end as rejected", async () => {
  const control = nativeControl();
  control.setAnswer("start_stack", { mode: "fail", problem: { said: "No." } });
  await callNative("start_stack").catch(() => {});
  expect(control.calls()[0]?.settled).toBe("rejected");
  control.setFallback(() => {
    throw new Error("no state");
  });
  await callNative("show_openbot").catch(() => {});
  expect(control.calls()[1]?.settled).toBe("rejected");
});

test("a never call stays unsettled until setAnswer settles it", async () => {
  const control = nativeControl();
  control.setAnswer("default_root", { mode: "never" });
  const promise = callNative("default_root");
  await Bun.sleep(0);
  expect(control.calls()[0]?.settled).toBeUndefined();
  control.setAnswer("default_root", { mode: "value", value: "/y" });
  expect(await promise).toBe("/y");
  expect(control.calls()[0]?.settled).toBe("resolved");
});
