import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { isPlainBotId, profileDirectoryFor } from "./bot-id";

const LIMITS = { entries: 10_000, depth: 16, milliseconds: 2_000 };
let measuring = false;

/**
 * Logical regular-file bytes for one Bot; never starts Chromium or reads file contents.
 * Linux descriptor paths anchor every lookup to an already-open directory. O_NOFOLLOW on each
 * child directory also refuses a symlink swapped in after lstat. Other platforms return unknown
 * until they have an equally bounded, descriptor-relative implementation.
 */
export async function profileBytes(
  root: string,
  botId: string,
  limits = LIMITS,
): Promise<number | null> {
  if (process.platform !== "linux" || !isPlainBotId(botId) || measuring) return null;
  measuring = true;
  let parent: FileHandle | undefined;
  let profile: FileHandle | undefined;
  const deadline = performance.now() + limits.milliseconds;
  let entries = 0;
  let bytes = 0;
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const anchored = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
  const check = () => {
    if (performance.now() >= deadline) throw new Error("Profile measurement deadline.");
  };
  try {
    check();
    parent = await open(root, flags);
    try {
      profile = await open(profileDirectoryFor(anchored(parent), botId), flags);
    } catch (error) {
      // A missing Bot profile is a measured zero; an inaccessible root is not.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const device = (await profile.stat()).dev;
    async function walk(handle: FileHandle, depth: number): Promise<void> {
      check();
      if (depth > limits.depth) throw new Error("Profile depth limit.");
      const before = await handle.stat();
      if (before.dev !== device) throw new Error("Profile mount refused.");
      const directory = await opendir(anchored(handle), { bufferSize: 32 });
      try {
        for (;;) {
          check();
          const entry = await directory.read();
          if (!entry) break;
          if (++entries > limits.entries) throw new Error("Profile entry limit.");
          const path = `${anchored(handle)}/${entry.name}`;
          const info = await lstat(path);
          check();
          // Chromium's SingletonLock/SingletonSocket/SingletonCookie links do not contribute
          // target bytes. Never open them, even if their targets point into another Bot's profile.
          if (info.isSymbolicLink()) continue;
          if (info.dev !== device) throw new Error("Profile mount refused.");
          if (info.isDirectory()) {
            const child = await open(path, flags);
            try {
              const actual = await child.stat();
              if (actual.ino !== info.ino || actual.dev !== info.dev)
                throw new Error("Profile directory changed.");
              await walk(child, depth + 1);
            } finally {
              await child.close();
            }
          } else if (info.isFile() && info.nlink === 1) {
            bytes += info.size;
            if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Profile size limit.");
          } else {
            throw new Error("Profile entry refused.");
          }
        }
      } finally {
        await directory.close();
      }
      const after = await handle.stat();
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new Error("Profile directory changed.");
      check();
    }
    await walk(profile, 0);
    return bytes;
  } catch {
    // Unknown is never a partial/estimated size, and errors must not disclose profile paths.
    return null;
  } finally {
    try {
      await profile?.close();
    } finally {
      try {
        await parent?.close();
      } finally {
        measuring = false;
      }
    }
  }
}
