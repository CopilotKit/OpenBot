import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  installIdFor,
  installSecret,
  readLocal,
  readSession,
  removeLocal,
  removeSession,
  restrictStorageToTrustedContexts,
  writeLocal,
  writeSession,
} from "../src/shared/storage";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake();
});
afterEach(() => {
  fake.uninstall();
});

describe("storage helpers", () => {
  test("a recording record of another shape (an old build's demonstration) is never handed out", async () => {
    const current = {
      recordingId: "rec-1",
      title: "T",
      openbotUrl: "https://openbot.example.test",
      userId: "u1",
      userName: "Ada",
      trajectoryIds: ["t-1"],
      startedAt: 1,
      kept: { reason: "Paused.", parked: true, events: 2, at: 3 },
    };
    const old = {
      demonstrationId: "demo-1",
      title: "T",
      openbotUrl: "https://openbot.example.test",
      userId: "u1",
      userName: "Ada",
      trajectoryIds: ["t-0"],
      startedAt: 1,
      discard: false,
      stopPending: true,
    };
    fake.storage.local.set("drains", [old, current, null, { recordingId: 5 }]);
    expect(await readLocal("drains")).toEqual([current]);
    fake.storage.local.set("drains", "not a list");
    expect(await readLocal("drains")).toEqual([]);
    fake.storage.local.set("activeRecording", old);
    expect(await readLocal("activeRecording")).toBeUndefined();
    fake.storage.local.set("activeRecording", current);
    expect(await readLocal("activeRecording")).toEqual(current);
  });

  test("local and session values round-trip and remove", async () => {
    expect(await readLocal("installSecret")).toBeUndefined();
    await writeLocal("installSecret", "s".repeat(64));
    expect(await readLocal("installSecret")).toBe("s".repeat(64));
    await removeLocal("installSecret");
    expect(await readLocal("installSecret")).toBeUndefined();

    await writeSession("digests", ["a".repeat(64)]);
    expect(await readSession("digests")).toEqual(["a".repeat(64)]);
    await removeSession("digests");
    expect(await readSession("digests")).toBeUndefined();
  });

  test("installSecret creates one value and keeps it across a service-worker restart", async () => {
    const first = await installSecret();
    expect(first.length).toBeGreaterThan(0);
    expect(await installSecret()).toBe(first);
    fake.restartServiceWorker();
    expect(await installSecret()).toBe(first);
  });

  test("installIdFor is 32 lowercase hex digits, stable, per origin and per copy", async () => {
    const a = await installIdFor("https://a.example.test");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await installIdFor("https://a.example.test")).toBe(a);
    expect(await installIdFor("https://b.example.test")).not.toBe(a);
    await writeLocal("installSecret", crypto.randomUUID());
    expect(await installIdFor("https://a.example.test")).not.toBe(a);
  });

  test("concurrent first calls agree on one secret and one install id", async () => {
    const [a, b] = await Promise.all([installSecret(), installSecret()]);
    expect(a).toBe(b);
    expect(await readLocal("installSecret")).toBe(a);

    await removeLocal("installSecret");
    const origin = "https://a.example.test";
    const [x, y] = await Promise.all([
      installIdFor(origin),
      installIdFor(origin),
    ]);
    expect(x).toBe(y);
  });

  test("restrictStorageToTrustedContexts records TRUSTED_CONTEXTS for local", async () => {
    await restrictStorageToTrustedContexts();
    expect(fake.storage.accessLevel).toBe("TRUSTED_CONTEXTS");
  });

  test("a restriction Chrome refuses is said where the Recorder's failures are, and never rejects", async () => {
    // The service worker asks for it at its top level with nobody waiting: a rejection there went unhandled.
    const refusal = new Error(
      "Access level can only be set from a trusted context.",
    );
    chrome.storage.local.setAccessLevel = async () => {
      throw refusal;
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await restrictStorageToTrustedContexts()).toBeUndefined();
      expect(logged).toHaveBeenCalledWith(
        "Recorder: keeping its stored connection from content scripts failed; it asks again at its next start",
        refusal,
      );
    } finally {
      logged.mockRestore();
    }
  });
});
