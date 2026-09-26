import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControl } from "../src/control";
import { createControlStore } from "../src/control-store";
const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "control-store-"));
  directories.push(directory);
  const store = createControlStore(directory, "bot-1");
  const control = createControl(undefined, { store });
  return { directory, store, control };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
test("atomic persisted completion remains exact across reload and later request", async () => {
  const { store, control, directory } = fixture();
  const first = control.requestHelp("Sign in", "call-1").request!;
  await control.take(first.id);
  control.release(first.id);
  control.requestSecret({ ref: "e1", label: "private label" });
  const restored = createControl(undefined, { store });
  expect(restored.get(first.id).request?.status).toBe("completed");
  expect(restored.get().resumeSnapshotRequired).toBe(true);
  expect(restored.requestHelp("Replay", "call-1").request?.id).toBe(first.id);
  restored.requestHelp("Next", "call-2");
  expect(restored.get(first.id).request?.status).toBe("completed");
  expect(restored.pendingSecret()).toBeNull();
  expect(
    readFileSync(join(directory, ".control", "bot-1.json"), "utf8"),
  ).not.toContain("private label");
  expect(readdirSync(join(directory, ".control"))).toEqual(["bot-1.json"]);
});
test("reload interrupts active requests and retains idempotent identity", async () => {
  for (const take of [false, true]) {
    const { store, control } = fixture();
    const first = control.requestHelp("Sign in", "call-1").request!;
    if (take) await control.take(first.id);
    const restored = createControl(undefined, { store });
    expect(restored.get(first.id).request?.status).toBe("interrupted");
    expect(restored.get().holder).toBe("bot");
    expect(restored.requestHelp("Replay", "call-1").request?.id).toBe(first.id);
    expect(() => restored.admitBotAction(true)).toThrow();
    expect(
      createControl(undefined, { store }).get(first.id).request?.status,
    ).toBe("interrupted");
  }
});
test("malformed store fails loudly; Bot ids cannot escape the control directory", () => {
  const { directory, control, store } = fixture();
  control.requestHelp("Sign in");
  const path = join(directory, ".control", "bot-1.json");
  for (const malformed of ["{", JSON.stringify({ version: 1, requests: [] })]) {
    writeFileSync(path, malformed);
    expect(() => createControl(undefined, { store })).toThrow();
  }
  expect(() => createControlStore(directory, "../other")).toThrow();
});
test("history remains bounded and keeps recent terminal requests", () => {
  const { control, store } = fixture();
  let latest = "";
  for (let index = 0; index < 50; index++) {
    latest = control.requestHelp("Sign in", `call-${index}`).request!.id;
    control.cancel(latest);
  }
  expect(store.load()!.requests.length).toBeLessThanOrEqual(33);
  expect(store.load()!.aliases["call-49"]).toBe(latest);
});

test("a write failure never becomes an in-memory success or reopens actions", () => {
  const failure = new Error("disk full");
  const control = createControl(undefined, {
    store: {
      load: () => undefined,
      save: () => {
        throw failure;
      },
    },
  });
  expect(() => control.requestHelp("Sign in")).toThrow(/could not be saved/);
  expect(() => control.get()).toThrow(/could not be saved/);
  expect(() => control.admitBotAction()).toThrow(/could not be saved/);
});

test("opaque tool call ids cannot collide with object prototype names", () => {
  const { control } = fixture();
  for (const toolCallId of ["__proto__", "constructor", "toString"]) {
    const request = control.requestHelp("Sign in", toolCallId).request!;
    control.cancel(request.id);
    expect(control.requestHelp("Replay", toolCallId).request?.id).toBe(
      request.id,
    );
  }
});
