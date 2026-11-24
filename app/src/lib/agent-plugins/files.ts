import { type PluginFile, pathInPlugin, wantsText } from "./read";
import { ArchiveError, readZip } from "./zip";

/**
 * The three ways a plugin arrives in the page, turned into the files `readPlugin` reads: a folder
 * from the folder picker, a `.zip` from the file picker, and either one dropped on the panel.
 */

/** A refusal whose message a person reads, from any of the three. */
export class PickError extends Error {}

/** The files of a folder the picker gave, by their path inside it. */
export async function folderFiles(
  files: readonly File[],
): Promise<PluginFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const path = pathInPlugin(file.webkitRelativePath || file.name);
      return { path, text: wantsText(path) ? await file.text() : null };
    }),
  );
}

/** A plugin's `.zip`. */
export async function archiveFiles(file: File): Promise<PluginFile[]> {
  try {
    return await readZip(new Uint8Array(await file.arrayBuffer()));
  } catch (thrown) {
    if (thrown instanceof ArchiveError) throw new PickError(thrown.message);
    throw thrown;
  }
}

export function isArchive(file: File): boolean {
  return /\.zip$/i.test(file.name);
}

/**
 * What was dropped: one folder, walked, or one `.zip`. Anything else says what to drop instead,
 * because a dropped loose file is almost always a SKILL.md or plugin.json picked out of its folder.
 */
export async function droppedFiles(
  transfer: DataTransfer,
): Promise<PluginFile[]> {
  const items = Array.from(transfer.items).filter(
    (item) => item.kind === "file",
  );
  if (items.length !== 1) {
    throw new PickError("Drop one plugin: its folder, or a .zip of it.");
  }
  const item = items[0];
  const entry = item?.webkitGetAsEntry?.() ?? null;
  if (entry?.isDirectory) {
    const files: PluginFile[] = [];
    await walk(entry as FileSystemDirectoryEntry, "", files);
    return files;
  }
  const file = item?.getAsFile();
  if (file && isArchive(file)) return archiveFiles(file);
  throw new PickError("Drop the plugin's folder, or a .zip of it.");
}

/** Every file under a dropped folder, by its path inside it. */
async function walk(
  directory: FileSystemDirectoryEntry,
  prefix: string,
  files: PluginFile[],
): Promise<void> {
  for (const entry of await entriesOf(directory)) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      await walk(entry as FileSystemDirectoryEntry, `${path}/`, files);
    } else {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      files.push({ path, text: wantsText(path) ? await file.text() : null });
    }
  }
}

/** A directory's entries. A reader hands them over in batches until one comes back empty. */
async function entriesOf(
  directory: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}
