import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspaceFileNotFoundError,
  WorkspaceFileTooLargeError,
  WorkspacePathError,
} from "../src/workspace";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "openbot-workspace-download-"));
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

async function downloadedBytes(body: Blob) {
  return Buffer.from(await new Response(body).arrayBuffer());
}

describe("downloading files from the workspace", () => {
  test("returns every byte without the text read limit", async () => {
    const payload = Buffer.alloc(70_000);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }
    await mkdir(join(root, "reports"), { recursive: true });
    await writeFile(join(root, "reports", "binary.dat"), payload);

    const download = await workspace().download("reports/binary.dat");

    expect(download.path).toBe("reports/binary.dat");
    expect(download.name).toBe("binary.dat");
    expect(download.bytes).toBe(payload.length);
    expect((await downloadedBytes(download.body)).equals(payload)).toBeTrue();
  });

  test("refuses a file above the download limit before returning a stream", async () => {
    const ws = createWorkspace(root, {
      readBytes: 64_000,
      writeBytes: 1_000,
      listEntries: 500,
      downloadBytes: 8,
    });
    await writeFile(join(root, "too-big.bin"), "123456789");

    await expect(ws.download("too-big.bin")).rejects.toThrow(
      WorkspaceFileTooLargeError,
    );
  });

  test("refuses a directory rather than streaming a platform-defined error", async () => {
    await mkdir(join(root, "folder"));
    await expect(workspace().download("folder")).rejects.toThrow(
      WorkspaceFileError,
    );
  });

  test("reports a missing file as not found", async () => {
    await expect(workspace().download("missing.bin")).rejects.toThrow(
      WorkspaceFileNotFoundError,
    );
  });

  test("refuses a symlink that escapes the workspace", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "leak.bin"));

    await expect(workspace().download("leak.bin")).rejects.toThrow(
      WorkspacePathError,
    );
  });

  test("allows a symlink that still points inside the workspace", async () => {
    await writeFile(join(root, "real.bin"), "inside");
    await symlink(join(root, "real.bin"), join(root, "alias.bin"));

    const download = await workspace().download("alias.bin");
    expect((await downloadedBytes(download.body)).toString("utf8")).toBe(
      "inside",
    );
  });

  test("refuses parent traversal and absolute paths", async () => {
    await expect(workspace().download("../outside/secret.txt")).rejects.toThrow(
      WorkspacePathError,
    );
    await expect(workspace().download("/etc/passwd")).rejects.toThrow(
      WorkspacePathError,
    );
  });
});
