import { type PluginFile, wantsText } from "./read";

/**
 * A plugin's `.zip`, read in the browser into the same files a picked folder gives.
 *
 * Plugins travel as archives, so a person should not have to unzip one to install it. The format
 * needs no dependency: the central directory names every entry and where it starts, and the only
 * compression an archive of text files uses in practice is deflate, which every current browser
 * inflates natively (`DecompressionStream("deflate-raw")`).
 *
 * Only the files `wantsText` names are inflated; everything else is listed by path, as a folder's
 * other files are. Each inflated file is capped, so a small archive cannot expand into a large one
 * in the page. Entries that would land outside the plugin (`..`, an absolute path) are dropped, and
 * so are the `__MACOSX/` copies Finder adds to every archive it makes.
 */

/** More than any manifest, server config or SKILL.md needs. */
const MAX_TEXT_BYTES = 1_000_000;
/** An archive bigger than this is not a plugin of skills and server configs. */
export const MAX_ARCHIVE_BYTES = 50_000_000;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

type Entry = {
  name: string;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  localOffset: number;
};

/** A refusal whose message a person reads. */
export class ArchiveError extends Error {}

export async function readZip(bytes: Uint8Array): Promise<PluginFile[]> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError(
      "This archive is over 50 MB, which is more than a plugin of skills and servers needs.",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = centralDirectory(bytes, view);
  const names = entries.map((entry) => entry.name);
  const prefix = sharedFolder(names);
  const files: PluginFile[] = [];
  for (const entry of entries) {
    const path = entry.name.slice(prefix.length);
    if (path === "") continue;
    files.push({
      path,
      text: wantsText(path) ? await textOf(bytes, view, entry) : null,
    });
  }
  return files;
}

function centralDirectory(bytes: Uint8Array, view: DataView): Entry[] {
  const end = findEnd(view);
  if (end === -1) {
    throw new ArchiveError("This file isn't a .zip archive.");
  }
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new ArchiveError(
      "This archive uses ZIP64, which OpenBot can't read. Zip the plugin folder again.",
    );
  }
  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (
      at + 46 > view.byteLength ||
      view.getUint32(at, true) !== CENTRAL_FILE_HEADER
    ) {
      throw new ArchiveError("This archive is damaged.");
    }
    const flags = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (isKept(name)) {
      entries.push({
        name: name.replace(/\\/g, "/"),
        method: view.getUint16(at + 10, true),
        encrypted: (flags & 1) === 1,
        compressedSize: view.getUint32(at + 20, true),
        size: view.getUint32(at + 24, true),
        localOffset: view.getUint32(at + 42, true),
      });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The end-of-central-directory record, searched for from the end past any archive comment. */
function findEnd(view: DataView): number {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - 0xffff);
  for (let at = last; at >= first; at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  return -1;
}

/** Files only, inside the plugin, without Finder's resource-fork copies. */
function isKept(name: string): boolean {
  const path = name.replace(/\\/g, "/");
  if (path.endsWith("/")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  if (parts.includes("..")) return false;
  if (parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store") return false;
  return true;
}

/**
 * The one folder every entry sits in, when the archive is a zipped folder rather than its contents:
 * `release-notes/plugin.json` is `plugin.json`. Nothing is stripped when a manifest is already at the
 * top, or when the entries don't share a folder.
 */
function sharedFolder(names: readonly string[]): string {
  if (names.some((name) => wantsManifest(name))) return "";
  const first = names[0]?.split("/")[0];
  if (!first || !names.every((name) => name.startsWith(`${first}/`))) return "";
  return `${first}/`;
}

function wantsManifest(path: string): boolean {
  return (
    path === "plugin.json" ||
    path === ".claude-plugin/plugin.json" ||
    path === ".codex-plugin/plugin.json"
  );
}

async function textOf(
  bytes: Uint8Array,
  view: DataView,
  entry: Entry,
): Promise<string | null> {
  if (entry.encrypted) {
    throw new ArchiveError(
      "This archive is password-protected. Zip the plugin folder again without a password.",
    );
  }
  if (entry.size > MAX_TEXT_BYTES) return null;
  const at = entry.localOffset;
  if (
    at + 30 > view.byteLength ||
    view.getUint32(at, true) !== LOCAL_FILE_HEADER
  ) {
    throw new ArchiveError("This archive is damaged.");
  }
  const start =
    at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) return null;
  return inflate(data, MAX_TEXT_BYTES);
}

/** Raw deflate, stopped at `limit` bytes whatever the header claimed. Null past the limit. */
async function inflate(
  data: Uint8Array,
  limit: number,
): Promise<string | null> {
  // A copy: a Blob takes a view of an ArrayBuffer, and `data` is a view into the whole archive.
  const stream = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    throw new ArchiveError("This archive is damaged.");
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
