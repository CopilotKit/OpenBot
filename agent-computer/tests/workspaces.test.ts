import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnusableBotIdError } from "../src/bot-id";
import { createWorkspaces, workspaceDirectoryFor } from "../src/workspaces";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workspaces-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a computer serving many Bots gives each its own files", async () => {
  const workspaces = createWorkspaces(root, true);
  const sales = await workspaces.for("sales");
  const support = await workspaces.for("support");
  await sales.files.write("notes.md", "sales only");

  expect((await sales.files.read("notes.md")).text).toBe("sales only");
  await expect(support.files.read("notes.md")).rejects.toThrow();
  expect((await support.files.list()).entries).toEqual([]);
});

test("a command starts in its Bot's folder, with HOME there too", async () => {
  const workspaces = createWorkspaces(root, true, { PATH: process.env.PATH });
  const { shell } = await workspaces.for("sales");
  const result = await shell.run({ command: 'pwd; echo "$HOME"' });
  // pwd reports the real path, which differs where the temporary directory is a symlink (macOS).
  const folder = await realpath(join(root, "computers", "sales"));
  const [cwd, home] = result.stdout.trim().split("\n");
  expect(cwd).toBe(folder);
  expect(await realpath(home ?? "")).toBe(folder);
});

test("a computer serving one Bot keeps its files where they were", async () => {
  await writeFile(join(root, "notes.md"), "from before");
  const workspaces = createWorkspaces(root, false);
  const { files } = await workspaces.for("sales");
  expect((await files.read("notes.md")).text).toBe("from before");
});

test("an id that is not a plain name never becomes a folder", () => {
  expect(() => workspaceDirectoryFor(root, "../etc", true)).toThrow(
    UnusableBotIdError,
  );
  expect(workspaceDirectoryFor(root, "../etc", false)).toBe(root);
});
