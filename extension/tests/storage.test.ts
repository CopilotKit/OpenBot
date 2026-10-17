import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  test("local and session values round-trip and remove", async () => {
    expect(await readLocal("lastBotId")).toBeUndefined();
    await writeLocal("lastBotId", "bot_1");
    expect(await readLocal("lastBotId")).toBe("bot_1");
    await removeLocal("lastBotId");
    expect(await readLocal("lastBotId")).toBeUndefined();

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

  test("restrictStorageToTrustedContexts records TRUSTED_CONTEXTS for local", async () => {
    await restrictStorageToTrustedContexts();
    expect(fake.storage.accessLevel).toBe("TRUSTED_CONTEXTS");
  });
});
