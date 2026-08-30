import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspacePathError,
} from "../src/workspace";

/**
 * The confinement, exercised against a real filesystem.
 *
 * Uses a real temporary directory rather than a mocked fs: two of the three layers of protection here
 * only mean anything against real inodes. A symlink test with a fake filesystem tests the fake.
 *
 * The escape attempts below are the ones an actual attempt would use, in the order it would use them,
 * and each one has to be tried with the guard in its shipping configuration. A deny-list test that
 * never runs with the escape hatch on proves nothing about the configuration people actually use.
 */

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "openbot-workspace-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "a private key", "utf8");
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

function workspace() {
  return createWorkspace(root);
}

describe("reading and writing inside the workspace", () => {
  test("writes a file and reads it back", async () => {
    const ws = workspace();
    const written = await ws.write("notes.md", "# Findings\nAll good.");
    expect(written).toMatchObject({ path: "notes.md", appended: false });

    const read = await ws.read("notes.md");
    expect(read.text).toBe("# Findings\nAll good.");
    expect(read.truncated).toBe(false);
  });

  test("creates parent directories inside the workspace", async () => {
    const ws = workspace();
    await ws.write("reports/august/summary.csv", "a,b\n1,2\n");
    expect((await ws.read("reports/august/summary.csv")).text).toBe(
      "a,b\n1,2\n",
    );
  });

  test("appends when asked, and overwrites when not", async () => {
    const ws = workspace();
    await ws.write("log.txt", "one\n");
    await ws.write("log.txt", "two\n", { append: true });
    expect((await ws.read("log.txt")).text).toBe("one\ntwo\n");

    await ws.write("log.txt", "fresh\n");
    expect((await ws.read("log.txt")).text).toBe("fresh\n");
  });

  test("a read is bounded and says so", async () => {
    const ws = createWorkspace(root, {
      readBytes: 10,
      writeBytes: 1000,
      listEntries: 500,
    });
    await ws.write("long.txt", "0123456789ABCDEF");
    const read = await ws.read("long.txt");
    expect(read.text).toBe("0123456789");
    expect(read.truncated).toBe(true);
    // The true size is reported even though the contents were cut, so the Bot can say so rather
    // than believing it has the whole file.
    expect(read.bytes).toBe(16);
  });

  test("reads at most the configured byte limit plus one from a large file", async () => {
    let requestedBytes = 0;
    const ws = createWorkspace(
      root,
      { readBytes: 10, writeBytes: 1000, listEntries: 500 },
      {
        async openFile(path) {
          const handle = await open(path, "r");
          return {
            async read(buffer, offset, length, position) {
              requestedBytes = Math.max(requestedBytes, buffer.byteLength);
              return handle.read(buffer, offset, length, position);
            },
            close: () => handle.close(),
          };
        },
      },
    );
    await writeFile(join(root, "huge.txt"), "x".repeat(1_000_000));

    const result = await ws.read("huge.txt");

    expect(requestedBytes).toBe(11);
    expect(result).toEqual({
      path: "huge.txt",
      text: "xxxxxxxxxx",
      truncated: true,
      bytes: 1_000_000,
    });
  });

  test("continues bounded reads when the filesystem returns short chunks", async () => {
    const source = Buffer.from("abcdef", "utf8");
    let calls = 0;
    const ws = createWorkspace(
      root,
      { readBytes: 5, writeBytes: 1000, listEntries: 500 },
      {
        async openFile() {
          return {
            async read(buffer, offset, length, position) {
              calls += 1;
              const start = position ?? 0;
              const bytesRead = Math.min(2, length, source.length - start);
              if (bytesRead > 0) {
                source.copy(buffer, offset, start, start + bytesRead);
              }
              return { bytesRead };
            },
            async close() {},
          };
        },
      },
    );
    await writeFile(join(root, "chunked.txt"), "xxxxxx");

    const result = await ws.read("chunked.txt");

    expect(calls).toBe(3);
    expect(result).toEqual({
      path: "chunked.txt",
      text: "abcde",
      truncated: true,
      bytes: 6,
    });
  });

  test("distinguishes exact-limit reads from limit-plus-one reads", async () => {
    const ws = createWorkspace(root, {
      readBytes: 4,
      writeBytes: 1000,
      listEntries: 500,
    });
    await writeFile(join(root, "exact.txt"), "1234");
    await writeFile(join(root, "over.txt"), "12345");

    expect(await ws.read("exact.txt")).toMatchObject({
      text: "1234",
      truncated: false,
      bytes: 4,
    });
    expect(await ws.read("over.txt")).toMatchObject({
      text: "1234",
      truncated: true,
      bytes: 5,
    });
  });

  test("does not emit a replacement artifact when truncation splits UTF-8", async () => {
    const ws = createWorkspace(root, {
      readBytes: 5,
      writeBytes: 1000,
      listEntries: 500,
    });
    await writeFile(join(root, "unicode.txt"), "abc📊tail");

    const result = await ws.read("unicode.txt");

    expect(result.text).toBe("abc");
    expect(result.text).not.toContain("�");
    expect(result.truncated).toBe(true);
  });

  test("a write that exceeds the limit is refused before it touches the disk", async () => {
    const ws = createWorkspace(root, {
      readBytes: 1000,
      writeBytes: 8,
      listEntries: 500,
    });
    await expect(ws.write("big.txt", "far too long")).rejects.toThrow(
      WorkspaceFileError,
    );
    await expect(ws.read("big.txt")).rejects.toThrow();
  });

  test("reading something that is not there says so plainly", async () => {
    await expect(workspace().read("nope.txt")).rejects.toThrow(
      WorkspaceFileError,
    );
  });

  test("reading a directory is refused rather than returning nonsense", async () => {
    const ws = workspace();
    await ws.write("folder/file.txt", "x");
    await expect(ws.read("folder")).rejects.toThrow(WorkspaceFileError);
  });
});

describe("listing the workspace", () => {
  test("lists files and folders, recursively, relative to the root", async () => {
    const ws = workspace();
    await ws.write("notes.md", "top level");
    await ws.write("reports/august/summary.csv", "nested");

    const listing = await ws.list();
    const paths = listing.entries.map((e) => e.path).sort();
    // Folders included, so a Bot can see the shape rather than only the leaves.
    expect(paths).toEqual([
      "notes.md",
      "reports",
      "reports/august",
      "reports/august/summary.csv",
    ]);
    expect(listing.truncated).toBe(false);
  });

  test("reports sizes for files and marks folders", async () => {
    const ws = workspace();
    await ws.write("a/b.txt", "12345");
    const byPath = new Map((await ws.list()).entries.map((e) => [e.path, e]));
    expect(byPath.get("a")).toMatchObject({ kind: "folder" });
    expect(byPath.get("a/b.txt")).toMatchObject({ kind: "file", bytes: 5 });
  });

  test("an empty workspace lists nothing, rather than failing", async () => {
    // The behaviour that matters: a Bot must be able to tell "no files" from "I could not look".
    const listing = await workspace().list();
    expect(listing.entries).toEqual([]);
  });

  test("can list a subfolder", async () => {
    const ws = workspace();
    await ws.write("reports/one.txt", "1");
    await ws.write("elsewhere/two.txt", "2");
    const paths = (await ws.list("reports")).entries.map((e) => e.path);
    expect(paths).toEqual(["reports/one.txt"]);
  });

  test("listing is bounded and says when it was cut", async () => {
    const ws = createWorkspace(root, {
      readBytes: 1000,
      writeBytes: 1000,
      listEntries: 3,
    });
    for (const n of [1, 2, 3, 4, 5]) await ws.write(`f${n}.txt`, "x");
    const listing = await ws.list();
    expect(listing.entries).toHaveLength(3);
    expect(listing.truncated).toBe(true);
  });

  test("listing cannot escape the workspace either", async () => {
    await expect(workspace().list("../outside")).rejects.toThrow(
      WorkspacePathError,
    );
    await expect(workspace().list("/etc")).rejects.toThrow(WorkspacePathError);
  });

  test("listing a file rather than a folder says so", async () => {
    const ws = workspace();
    await ws.write("notes.md", "x");
    await expect(ws.list("notes.md")).rejects.toThrow(WorkspaceFileError);
  });
});

describe("escaping the workspace", () => {
  test.each([
    ["parent traversal", "../outside/secret.txt"],
    ["deep traversal", "../../../../etc/passwd"],
    ["traversal in the middle", "reports/../../outside/secret.txt"],
    ["absolute path", "/etc/passwd"],
    ["absolute path into the sibling", "/tmp"],
    ["backslash traversal", "..\\outside\\secret.txt"],
    ["bare parent", ".."],
  ])("refuses %s", async (_label, path) => {
    await expect(workspace().read(path)).rejects.toThrow(WorkspacePathError);
    await expect(workspace().write(path, "owned")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("refuses to read THROUGH a symlink that points outside", async () => {
    // The layer people miss. This path contains no "..", is not absolute, and resolves inside the
    // workspace lexically. Only following the link reveals where it goes.
    await symlink(join(outside, "secret.txt"), join(root, "innocent.txt"));
    await expect(workspace().read("innocent.txt")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("refuses to write THROUGH a symlinked directory that points outside", async () => {
    await symlink(outside, join(root, "escape"));
    await expect(workspace().write("escape/owned.txt", "x")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("refuses to write THROUGH a symlinked FILE that points outside", async () => {
    // The asymmetry between the two tests above. Resolving `dirname` catches a link standing in for a
    // directory; a link standing in for the FILE has the workspace as its parent and passes, and then
    // `writeFile` follows it. Refusing is only half of what this asserts: the file outside has to be
    // untouched afterwards, because an error thrown after the bytes landed would still be an escape.
    const secret = join(outside, "secret.txt");
    await symlink(secret, join(root, "notes.txt"));
    await expect(workspace().write("notes.txt", "owned")).rejects.toThrow(
      WorkspacePathError,
    );
    expect(await readFile(secret, "utf8")).toBe("a private key");
  });

  test("refuses to append THROUGH a symlinked file that points outside", async () => {
    // `append` is a separate flag reaching a separate `writeFile` mode, so it is a separate way in.
    const secret = join(outside, "secret.txt");
    await symlink(secret, join(root, "log.txt"));
    await expect(
      workspace().write("log.txt", "owned", { append: true }),
    ).rejects.toThrow(WorkspacePathError);
    expect(await readFile(secret, "utf8")).toBe("a private key");
  });

  test("refuses to write through a DANGLING link that points outside", async () => {
    // The harder half. `realpath` throws on a link whose destination does not exist, so a check built
    // on it treats this as "no such file" and lets the write through the failure path, while
    // `writeFile` creates the destination regardless. Nothing exists here to prove the escape with,
    // so the assertion is that the file was never created outside.
    const notThere = join(outside, "planted.txt");
    await symlink(notThere, join(root, "fresh.txt"));
    await expect(workspace().write("fresh.txt", "owned")).rejects.toThrow(
      WorkspacePathError,
    );
    await expect(readFile(notThere, "utf8")).rejects.toThrow();
  });

  test("refuses a chain of links that ends up outside", async () => {
    // One hop is the obvious case and the only one a single `readlink` would catch.
    await symlink(join(outside, "secret.txt"), join(root, "second.txt"));
    await symlink(join(root, "second.txt"), join(root, "first.txt"));
    await expect(workspace().write("first.txt", "owned")).rejects.toThrow(
      WorkspacePathError,
    );
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
      "a private key",
    );
  });

  test("refuses a cycle of links rather than following it forever", async () => {
    // Two links pointing at each other never reach something that is not a link. The walk has to stop
    // on its own and say why, instead of spinning or surfacing an ELOOP from the write.
    await symlink(join(root, "b.txt"), join(root, "a.txt"));
    await symlink(join(root, "a.txt"), join(root, "b.txt"));
    await expect(workspace().write("a.txt", "owned")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("writing THROUGH a link that points back inside still works", async () => {
    // Confining, not forbidding, on the write side too. Refusing every link would pass the tests
    // above and quietly break a Bot that keeps `latest.csv` pointing at the newest report.
    const ws = workspace();
    await ws.write("real/data.txt", "before");
    await symlink(join(root, "real/data.txt"), join(root, "alias.txt"));
    await ws.write("alias.txt", "after");
    expect((await ws.read("real/data.txt")).text).toBe("after");
  });

  test("a symlink pointing back INSIDE the workspace still works", async () => {
    // The guard must confine, not merely forbid symlinks: refusing every link would be easier and
    // would break legitimate use.
    const ws = workspace();
    await ws.write("real/data.txt", "inside");
    await symlink(join(root, "real"), join(root, "alias"));
    expect((await ws.read("alias/data.txt")).text).toBe("inside");
  });

  test("a sibling directory sharing the root's name prefix is still outside", async () => {
    // `/tmp/x/workspace-evil` shares a string prefix with `/tmp/x/workspace`, so a containment check
    // written with startsWith would let it through.
    const evil = `${root}-evil`;
    await mkdir(evil, { recursive: true });
    await writeFile(join(evil, "loot.txt"), "nope", "utf8");
    await expect(
      workspace().read("../workspace-evil/loot.txt"),
    ).rejects.toThrow(WorkspacePathError);
  });

  test("an empty or blank path is refused", async () => {
    await expect(workspace().read("")).rejects.toThrow(WorkspacePathError);
    await expect(workspace().write("   ", "x")).rejects.toThrow(
      WorkspacePathError,
    );
  });
});
