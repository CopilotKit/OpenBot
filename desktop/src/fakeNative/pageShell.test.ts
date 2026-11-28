import { beforeEach, expect, test } from "bun:test";
import { nativeControl } from "./control";
import { installPageShell } from "./pageShell";

beforeEach(() => nativeControl().reset());

test("install puts the shell on the target", () => {
  const target: { __TAURI_INTERNALS__?: unknown } = {};
  const { shell } = installPageShell(target);
  expect(target.__TAURI_INTERNALS__).toBe(shell);
});

test("invoke logs a known page command", async () => {
  const { shell } = installPageShell({});
  await shell.invoke("plugin:openbot-desktop|status", { a: 1 });
  const calls = nativeControl().calls();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.command).toBe("plugin:openbot-desktop|status");
  expect(calls[0]?.args).toEqual({ a: 1 });
  expect(calls[0]?.known).toBe(true);
});

test("invoke logs an unknown command as not known", async () => {
  const { shell } = installPageShell({});
  await shell.invoke("plugin:openbot-desktop|nope");
  expect(nativeControl().calls()[0]?.known).toBe(false);
});

test("a value answer resolves with that value", async () => {
  nativeControl().setAnswer("plugin:openbot-desktop|zoom", {
    mode: "value",
    value: 1.25,
  });
  const { shell } = installPageShell({});
  expect(await shell.invoke("plugin:openbot-desktop|zoom")).toBe(1.25);
});

test("a fail answer rejects with the same object", async () => {
  const problem = { said: "The update did not install." };
  nativeControl().setAnswer("plugin:openbot-desktop|install_update", {
    mode: "fail",
    problem,
  });
  const { shell } = installPageShell({});
  const reason = await shell
    .invoke("plugin:openbot-desktop|install_update")
    .catch((error: unknown) => error);
  expect(reason).toBe(problem);
});

test("deliver reaches the callback; an unknown id gives false", () => {
  const { shell, deliver } = installPageShell({});
  const seen: unknown[] = [];
  const first = shell.transformCallback((message) => seen.push(message));
  const second = shell.transformCallback(() => {});
  expect(first).toBe(1);
  expect(second).toBe(2);
  expect(deliver(first, { index: 0 })).toBe(true);
  expect(deliver(first, { index: 1 })).toBe(true);
  expect(seen).toEqual([{ index: 0 }, { index: 1 }]);
  expect(deliver(99, {})).toBe(false);
});

test("a once callback is removed after its first delivery", () => {
  const { shell, deliver } = installPageShell({});
  const seen: unknown[] = [];
  const id = shell.transformCallback((message) => seen.push(message), true);
  expect(deliver(id, "a")).toBe(true);
  expect(deliver(id, "b")).toBe(false);
  expect(seen).toEqual(["a"]);
});

test("unregisterCallback removes the callback", () => {
  const { shell, deliver } = installPageShell({});
  const id = shell.transformCallback(() => {});
  shell.unregisterCallback(id);
  expect(deliver(id, "a")).toBe(false);
});

test("remove deletes the property", () => {
  const target: { __TAURI_INTERNALS__?: unknown } = {};
  const { remove } = installPageShell(target);
  remove();
  expect("__TAURI_INTERNALS__" in target).toBe(false);
});
