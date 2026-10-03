import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileBytes } from "../src/profile-usage";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "profile-usage-"));
  await mkdir(join(root, "bot", "Default"), { recursive: true });
  await writeFile(join(root, "bot", "Default", "History"), "12345");
  await writeFile(join(root, "bot", "Preferences"), "123");
  return root;
}

describe.skipIf(process.platform !== "linux")("descriptor-anchored profile usage", () => {
  test("counts only the requested Bot's regular files without creating a missing profile", async () => {
    await fixture();
    await mkdir(join(root, "other"));
    await writeFile(join(root, "other", "Cookies"), "PRIVATE".repeat(100));
    expect(await profileBytes(root, "bot")).toBe(8);
    expect(await profileBytes(root, "new-bot")).toBe(0);
    expect(await profileBytes(join(root, "missing-root"), "bot")).toBeNull();
  });
  test("never follows file, directory, dangling or cyclic symbolic links", async () => {
    await fixture();
    await mkdir(join(root, "other"));
    await writeFile(join(root, "other", "Cookies"), "PRIVATE");
    await symlink(join(root, "other"), join(root, "bot", "outside"));
    await symlink(join(root, "other", "Cookies"), join(root, "bot", "SingletonCookie"));
    await symlink("/nonexistent-profile-lock", join(root, "bot", "SingletonLock"));
    await symlink(join(root, "bot"), join(root, "bot", "cycle"));
    expect(await profileBytes(root, "bot")).toBe(8);
    await symlink(join(root, "other"), join(root, "linked-bot"));
    expect(await profileBytes(root, "linked-bot")).toBeNull();
    await symlink(root, join(root, "linked-root"));
    expect(await profileBytes(join(root, "linked-root"), "bot")).toBeNull();
  });
  test("refuses hardlinks, invalid identities and exhausted bounds without partial bytes", async () => {
    await fixture();
    expect(await profileBytes(root, "../bot")).toBeNull();
    expect(
      await profileBytes(root, "bot", { entries: 1, depth: 16, milliseconds: 2000 }),
    ).toBeNull();
    expect(
      await profileBytes(root, "bot", { entries: 100, depth: 0, milliseconds: 2000 }),
    ).toBeNull();
    expect(
      await profileBytes(root, "bot", { entries: 100, depth: 16, milliseconds: 0 }),
    ).toBeNull();
    await link(join(root, "bot", "Preferences"), join(root, "bot", "copy"));
    expect(await profileBytes(root, "bot")).toBeNull();
  });
  test("admits one traversal at a time and releases it after refusal", async () => {
    await fixture();
    const pending = profileBytes(root, "bot");
    expect(await profileBytes(root, "bot")).toBeNull();
    expect(await pending).toBe(8);
    expect(
      await profileBytes(root, "bot", { entries: 0, depth: 16, milliseconds: 2000 }),
    ).toBeNull();
    expect(await profileBytes(root, "bot")).toBe(8);
  });
});

test.skipIf(process.platform === "linux")(
  "unsupported traversal platforms report unknown",
  async () => {
    await fixture();
    expect(await profileBytes(root, "bot")).toBeNull();
  },
);
