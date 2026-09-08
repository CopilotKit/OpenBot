import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteInboxAttachment,
  exportAttachment,
  importAttachment,
} from "../src/file-attachments";
import { createWorkspace } from "../src/workspace";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "openbot-attachments-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(join(root, "downloads"), { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("exporting an attachment", () => {
  test("returns real PDF bytes with independently derived metadata", async () => {
    await writeFile(join(root, "downloads", "invoice.pdf"), pdf);

    const exported = await exportAttachment(
      createWorkspace(root),
      "downloads/invoice.pdf",
    );

    expect(exported.metadata).toEqual({
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: pdf.length,
      sha256: createHash("sha256").update(pdf).digest("hex"),
    });
    expect(exported.bytes).toEqual(pdf);
  });

  test.each(["../outside/secret.pdf", "/etc/passwd"])(
    "refuses the unsafe path %s",
    async (path) => {
      await expect(
        exportAttachment(createWorkspace(root), path),
      ).rejects.toThrow();
    },
  );

  test("refuses a symlink even when its destination is another allowed PDF", async () => {
    await writeFile(join(root, "downloads", "real.pdf"), pdf);
    await symlink("real.pdf", join(root, "downloads", "linked.pdf"));

    await expect(
      exportAttachment(createWorkspace(root), "downloads/linked.pdf"),
    ).rejects.toThrow(/link/i);
  });

  test("refuses an extension whose bytes have another type", async () => {
    await writeFile(join(root, "downloads", "pretend.pdf"), "plain text");

    await expect(
      exportAttachment(createWorkspace(root), "downloads/pretend.pdf"),
    ).rejects.toThrow(/type/i);
  });
});

describe("importing an attachment", () => {
  test("writes atomically beneath the server-generated inbox path", async () => {
    const handoffId = "a".repeat(64);
    const attachmentId = randomUUID();
    const metadata = {
      handoffId,
      attachmentId,
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: pdf.length,
      sha256: createHash("sha256").update(pdf).digest("hex"),
    };

    const imported = await importAttachment(
      createWorkspace(root),
      metadata,
      pdf,
    );

    expect(imported).toEqual({
      ...metadata,
      path: `inbox/${handoffId}/${attachmentId}/invoice.pdf`,
    });
    expect(await readFile(join(root, imported.path))).toEqual(pdf);
    await expect(
      lstat(`${join(root, imported.path)}.partial`),
    ).rejects.toThrow();
  });

  test("retries the same immutable attachment without replacing it", async () => {
    const metadata = {
      handoffId: "d".repeat(64),
      attachmentId: randomUUID(),
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: pdf.length,
      sha256: createHash("sha256").update(pdf).digest("hex"),
    };
    const workspace = createWorkspace(root);

    const first = await importAttachment(workspace, metadata, pdf);
    const before = await lstat(join(root, first.path));
    const second = await importAttachment(workspace, metadata, pdf);
    const after = await lstat(join(root, second.path));

    expect(second).toEqual(first);
    expect(after.ino).toBe(before.ino);
  });

  test("refuses a retry whose existing destination has different bytes", async () => {
    const metadata = {
      handoffId: "e".repeat(64),
      attachmentId: randomUUID(),
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: pdf.length,
      sha256: createHash("sha256").update(pdf).digest("hex"),
    };
    const destination = join(
      root,
      "inbox",
      metadata.handoffId,
      metadata.attachmentId,
      metadata.filename,
    );
    await mkdir(join(destination, ".."), { recursive: true });
    const different = Buffer.from(pdf);
    different[different.length - 1] = 0x21;
    await writeFile(destination, different);

    await expect(
      importAttachment(createWorkspace(root), metadata, pdf),
    ).rejects.toThrow(/different attachment/i);
    expect(await readFile(destination)).toEqual(different);
  });

  test("a failed import leaves neither a final nor partial file", async () => {
    const handoffId = "b".repeat(64);
    const attachmentId = randomUUID();
    const metadata = {
      handoffId,
      attachmentId,
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: pdf.length,
      sha256: "0".repeat(64),
    };

    await expect(
      importAttachment(createWorkspace(root), metadata, pdf),
    ).rejects.toThrow(/hash/i);
    const destination = join(
      root,
      "inbox",
      handoffId,
      attachmentId,
      "invoice.pdf",
    );
    await expect(lstat(destination)).rejects.toThrow();
    await expect(lstat(`${destination}.partial`)).rejects.toThrow();
  });

  test("deletes only the exact generated inbox attachment", async () => {
    const handoffId = "c".repeat(64);
    const attachmentId = randomUUID();
    const metadata = {
      handoffId,
      attachmentId,
      filename: "invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: pdf.length,
      sha256: createHash("sha256").update(pdf).digest("hex"),
    };
    const workspace = createWorkspace(root);
    await importAttachment(workspace, metadata, pdf);

    expect(await deleteInboxAttachment(workspace, metadata)).toEqual({
      deleted: true,
    });
    expect(await deleteInboxAttachment(workspace, metadata)).toEqual({
      deleted: false,
    });
  });
});
