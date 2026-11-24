import { unzipSync } from "fflate";
import {
  BuddyFormatError,
  type BuddyHeader,
  type BuddySeed,
  type LoadedBuddy,
  mimeFor,
  parseBuddyMetaBytes,
  readBuddySeedFromZip,
} from "./format";

// Re-export the isomorphic format so client code can get everything it needs
// (types, poses, pack, loaders, cache) from the single "/browser" entry.
export * from "./format";

function blobUrl(data: Uint8Array, name: string): string {
  // Copy into a fresh ArrayBuffer-backed view so it satisfies BlobPart.
  return URL.createObjectURL(
    new Blob([new Uint8Array(data)], { type: mimeFor(name) }),
  );
}

export function loadBuddyFromZip(zip: Uint8Array): LoadedBuddy {
  const files = unzipSync(zip);
  const metaRaw = files["metadata.json"];
  if (!metaRaw)
    throw new BuddyFormatError("metadata.json missing from .buddy file");
  const meta = parseBuddyMetaBytes(metaRaw);

  const objectUrls: Array<string> = [];
  const take = (fname?: string): string | null => {
    if (!fname || !files[fname]) return null;
    const url = blobUrl(files[fname], fname);
    objectUrls.push(url);
    return url;
  };

  const avatarUrl = take(meta.avatar);
  const inspirationUrl = take(meta.inspiration);
  // Load every pose present in metadata — standard POSE_IDS and any
  // app-specific custom poses alike.
  const poseUrls: Record<string, string> = {};
  for (const id of Object.keys(meta.poses ?? {})) {
    const url = take(meta.poses[id]);
    if (url) poseUrls[id] = url;
  }

  // Surface the file's home pose only when it names a clip we actually loaded;
  // otherwise leave it undefined so the controller's fallback chain applies.
  const homePose =
    meta.homePose && poseUrls[meta.homePose] ? meta.homePose : undefined;

  return {
    meta,
    avatarUrl,
    inspirationUrl,
    poseUrls,
    homePose,
    kind: "owned",
    objectUrls,
  };
}

export async function loadBuddyFromUrl(url: string): Promise<LoadedBuddy> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  return loadBuddyFromZip(new Uint8Array(await res.arrayBuffer()));
}

export function loadBuddyFromFile(file: File): Promise<LoadedBuddy> {
  return file.arrayBuffer().then((b) => loadBuddyFromZip(new Uint8Array(b)));
}

// Lightweight: metadata + avatar only (skips inflating the pose videos).
export function loadBuddyHeaderFromZip(zip: Uint8Array): BuddyHeader {
  const metaOnly = unzipSync(zip, {
    filter: (f) => f.name === "metadata.json",
  });
  const metaRaw = metaOnly["metadata.json"];
  if (!metaRaw)
    throw new BuddyFormatError("metadata.json missing from .buddy file");
  const meta = parseBuddyMetaBytes(metaRaw);
  const objectUrls: Array<string> = [];
  let avatarUrl: string | null = null;
  if (meta.avatar) {
    const av = unzipSync(zip, { filter: (f) => f.name === meta.avatar });
    if (av[meta.avatar]) {
      avatarUrl = blobUrl(av[meta.avatar], meta.avatar);
      objectUrls.push(avatarUrl);
    }
  }
  return { meta, avatarUrl, objectUrls };
}

export async function loadBuddyHeaderFromUrl(
  url: string,
): Promise<BuddyHeader> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  return loadBuddyHeaderFromZip(new Uint8Array(await res.arrayBuffer()));
}

export async function loadBuddyHeaderFromFile(
  file: File,
): Promise<BuddyHeader> {
  return loadBuddyHeaderFromZip(new Uint8Array(await file.arrayBuffer()));
}

export function revokeBuddyHeader(h: BuddyHeader): void {
  h.objectUrls.forEach((u) => URL.revokeObjectURL(u));
}

/**
 * Revoke an owned buddy's object URLs. Safe to call on any LoadedBuddy: a
 * `shared` instance (minted by getBuddy, owned by the cache) is a no-op, so the
 * cache's URLs stay valid for other consumers. Only `owned` instances
 * (loadBuddyFromFile / loadBuddyFromZip) are actually revoked.
 */
export function revokeBuddy(b: LoadedBuddy): void {
  if (b.kind === "shared") return;
  b.objectUrls.forEach((u) => URL.revokeObjectURL(u));
}

export async function readBuddySeedFromFile(file: File): Promise<BuddySeed> {
  return readBuddySeedFromZip(new Uint8Array(await file.arrayBuffer()));
}

// ---- local buddy cache (in-memory over Cache Storage) ----------------------
// See the design notes in the original app: in-memory LoadedBuddy map (shared,
// never revoke) over raw .buddy bytes persisted in the Cache Storage API.

// Bump this to invalidate every client's persisted bytes at once (e.g. after
// regenerating the shipped buddies). Old-named caches are deleted on load below.
const CACHE_NAME = "buddy-bytes-v2";
const mem = new Map<string, Promise<LoadedBuddy>>();

function cacheStorageAvailable(): boolean {
  return typeof caches !== "undefined";
}

async function readBytesFromCache(url: string): Promise<Uint8Array | null> {
  if (!cacheStorageAvailable()) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(url);
    if (!res) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function writeBytesToCache(
  url: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!cacheStorageAvailable()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      url,
      new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/zip" },
      }),
    );
  } catch {
    // quota / unsupported — degrade to network-only
  }
}

/**
 * Raw .buddy bytes for a url: Cache Storage first, then network (+ backfill).
 * `force` bypasses the persistent layer and overwrites it with a fresh fetch.
 */
export async function getBuddyBytes(
  url: string,
  opts?: { force?: boolean },
): Promise<Uint8Array> {
  if (!opts?.force) {
    const cached = await readBytesFromCache(url);
    if (cached) return cached;
  }
  // Bypass the HTTP disk cache — Cache Storage is our durable layer.
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  void writeBytesToCache(url, bytes);
  return bytes;
}

/**
 * A decoded, persistently-cached buddy for a url. Shared — do not revoke it
 * (revokeBuddy is a safe no-op on it). Pass `{ force: true }` to bypass both
 * cache layers, refetch, and replace the cached bytes + shared instance so a
 * changed file at the same url is picked up.
 */
export function getBuddy(
  url: string,
  opts?: { force?: boolean },
): Promise<LoadedBuddy> {
  if (opts?.force) mem.delete(url);
  let pending = mem.get(url);
  if (!pending) {
    pending = getBuddyBytes(url, opts).then((bytes) => {
      const buddy = loadBuddyFromZip(bytes);
      buddy.kind = "shared";
      return buddy;
    });
    pending.catch(() => {
      if (mem.get(url) === pending) mem.delete(url);
    });
    mem.set(url, pending);
  }
  return pending;
}

export function isBuddyCached(url: string): boolean {
  return mem.has(url);
}

/** Forget a url's cached bytes + decoded buddy so the next load re-fetches. */
export async function invalidateBuddy(url: string): Promise<void> {
  mem.delete(url);
  if (!cacheStorageAvailable()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(url);
  } catch {
    // ignore
  }
}

export async function clearBuddyCache(): Promise<void> {
  mem.clear();
  if (!cacheStorageAvailable()) return;
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    // ignore
  }
}

// Dev convenience: bust the cache from the console after regenerating a .buddy.
// e.g. `await buddyCache.clear()` or `buddyCache.invalidate(url)`.
if (typeof window !== "undefined") {
  (window as unknown as { buddyCache?: unknown }).buddyCache = {
    invalidate: invalidateBuddy,
    clear: clearBuddyCache,
    isCached: isBuddyCached,
  };
}

// On load, drop any older-versioned buddy caches (no reverse compat needed), so a
// CACHE_NAME bump frees the stale bytes instead of orphaning them.
if (typeof caches !== "undefined") {
  void caches
    .keys()
    .then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("buddy-bytes-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      ),
    )
    .catch(() => {});
}
