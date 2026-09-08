import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import type { Workspace } from "./workspace";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const HANDOFF_ID = /^[a-f0-9]{64}$/;
const ATTACHMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export type AttachmentMetadata = {
  handoffId: string;
  attachmentId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
};

export async function exportAttachment(
  workspace: Workspace,
  path: string,
): Promise<{
  metadata: Omit<AttachmentMetadata, "handoffId" | "attachmentId">;
  bytes: Buffer;
}> {
  const full = await workspace.resolvePath(path, false, {
    refuseSymlinks: true,
  });
  const before = await lstat(full);
  if (!before.isFile()) throw new Error("Only regular files can be attached.");
  if (before.size < 1 || before.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachment size must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes.`,
    );
  }

  const bytes = await readFile(full);
  const after = await stat(full);
  if (
    bytes.length !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error("The attachment changed while it was being read.");
  }
  const filename = safeFilename(basename(path));
  const mediaType = mediaTypeFor(filename, bytes);
  return {
    metadata: {
      filename,
      mediaType,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    bytes,
  };
}

export async function importAttachment(
  workspace: Workspace,
  metadata: AttachmentMetadata,
  bytes: Buffer,
): Promise<AttachmentMetadata & { path: string }> {
  validateIdentity(metadata);
  const filename = safeFilename(metadata.filename);
  if (bytes.length !== metadata.sizeBytes) {
    throw new Error("The attachment size does not match its declaration.");
  }
  if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("The attachment size is outside the allowed limit.");
  }
  if (mediaTypeFor(filename, bytes) !== metadata.mediaType) {
    throw new Error("The attachment type does not match its declaration.");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
    throw new Error("The attachment hash does not match its declaration.");
  }

  const path = `inbox/${metadata.handoffId}/${metadata.attachmentId}/${filename}`;
  const destination = await workspace.resolvePath(path, true);
  const partial = `${destination}.${randomUUID()}.partial`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await writeFile(partial, bytes, { flag: "wx" });
    try {
      // Hard-linking a completed temporary file is an atomic create-if-absent. `rename` would
      // replace an existing destination on POSIX, allowing a retry to overwrite the immutable
      // attachment another process is already using.
      await link(partial, destination);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await assertSameExistingAttachment(destination, metadata, bytes);
    }
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
  await rm(partial, { force: true });
  return { ...metadata, filename, path };
}

async function assertSameExistingAttachment(
  destination: string,
  metadata: AttachmentMetadata,
  expected: Buffer,
): Promise<void> {
  const details = await lstat(destination);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("The attachment destination is not a regular file.");
  }
  const existing = await readFile(destination);
  if (
    existing.length !== metadata.sizeBytes ||
    createHash("sha256").update(existing).digest("hex") !== metadata.sha256 ||
    !existing.equals(expected)
  ) {
    throw new Error("The destination already contains a different attachment.");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

export async function deleteInboxAttachment(
  workspace: Workspace,
  metadata: AttachmentMetadata,
): Promise<{ deleted: boolean }> {
  validateIdentity(metadata);
  const filename = safeFilename(metadata.filename);
  const path = `inbox/${metadata.handoffId}/${metadata.attachmentId}/${filename}`;
  const destination = await workspace.resolvePath(path, true);
  const existed = await lstat(destination).catch(() => null);
  if (existed?.isSymbolicLink()) {
    throw new Error("An inbox attachment cannot be a link.");
  }
  if (existed && !existed.isFile()) {
    throw new Error("An inbox attachment must be a regular file.");
  }
  await rm(destination, { force: true });
  return { deleted: existed !== null };
}

function validateIdentity(metadata: AttachmentMetadata): void {
  if (!HANDOFF_ID.test(metadata.handoffId))
    throw new Error("Invalid handoff id.");
  if (!ATTACHMENT_ID.test(metadata.attachmentId)) {
    throw new Error("Invalid attachment id.");
  }
  if (!SHA256.test(metadata.sha256))
    throw new Error("Invalid attachment hash.");
}

function safeFilename(value: string): string {
  if (
    !value ||
    value.length > 255 ||
    value !== basename(value) ||
    hasForbiddenFilenameCharacter(value)
  ) {
    throw new Error("Invalid attachment filename.");
  }
  return value;
}

function hasForbiddenFilenameCharacter(value: string): boolean {
  for (const character of value) {
    if (
      character === "/" ||
      character === "\\" ||
      character.charCodeAt(0) <= 31
    ) {
      return true;
    }
  }
  return false;
}

function mediaTypeFor(filename: string, bytes: Buffer): string {
  const extension = extname(filename).toLowerCase();
  if (
    extension === ".pdf" &&
    bytes.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return "application/pdf";
  }
  if (
    [".jpg", ".jpeg"].includes(extension) &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    extension === ".png" &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (
    extension === ".webp" &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if ([".txt", ".md", ".csv"].includes(extension)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return extension === ".csv" ? "text/csv" : "text/plain";
    } catch {
      throw new Error("The attachment type does not match its extension.");
    }
  }
  throw new Error("The attachment type does not match an allowed extension.");
}
