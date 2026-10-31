import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hasHostPermission } from "../src/shared/host-access";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake();
});
afterEach(() => {
  fake.uninstall();
});

describe("hasHostPermission", () => {
  test("is false while website access is withheld", async () => {
    expect(await hasHostPermission()).toBe(false);
  });

  test("is true once <all_urls> is granted", async () => {
    fake.permissions.granted.add("<all_urls>");
    expect(await hasHostPermission()).toBe(true);
  });

  test("is false when only a single origin is granted", async () => {
    fake.permissions.granted.add("https://openbot.example.test/*");
    expect(await hasHostPermission()).toBe(false);
  });

  test("asks Chrome about <all_urls> only", async () => {
    await hasHostPermission();
    expect(fake.calls).toContain("permissions.contains");
  });
});
