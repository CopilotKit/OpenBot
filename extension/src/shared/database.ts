export const RECORDER_DATABASE = "openbot-recorder";
export const RECORDER_DATABASE_VERSION = 2;

/**
 * Every object store:
 *  events  keyPath ["trajectoryId", "seq"]        the streamer's outbox
 *  meta    out-of-line string keys                 "trajectory:<id>", each trajectory's own record, and "seq", the last
 *                                                  seq issued
 * Nothing else is kept in this browser: a recording's events wait here until Intelligence acknowledges them.
 *
 * Version 2 drops what a build from before the Recorder sent to Intelligence only left behind: every other store (its
 * screen, voice, step and network-body stores), every other meta key, and each trajectory record without a recording
 * id (a demonstration's) with its events. Nothing can send those any more.
 */
export const STORES = ["events", "meta"] as const;
type StoreName = (typeof STORES)[number];

const SEQ_KEY = "seq";
const TRAJECTORY_PREFIX = "trajectory:";

/** Removes, inside the upgrade's transaction, every meta key the outbox does not use and every trajectory record with
 * no recording id, with that trajectory's events. */
function dropLeftovers(upgrade: IDBTransaction): void {
  const meta = upgrade.objectStore("meta");
  const events = upgrade.objectStore("events");
  const cursor = meta.openCursor();
  cursor.onsuccess = () => {
    const at = cursor.result;
    if (!at) return;
    const key = String(at.key);
    if (key.startsWith(TRAJECTORY_PREFIX)) {
      const record = at.value as { recordingId?: unknown } | null;
      if (typeof record?.recordingId !== "string") {
        const trajectoryId = key.slice(TRAJECTORY_PREFIX.length);
        events.delete(
          IDBKeyRange.bound(
            [trajectoryId, -Infinity],
            [trajectoryId, Infinity],
          ),
        );
        at.delete();
      }
    } else if (key !== SEQ_KEY) at.delete();
    at.continue();
  };
}

/**
 * Opens (and on first use creates) the database; `name` lets tests use a fresh one per case. A later schema change
 * bumps the version here and adds its upgrade step here, never in a caller.
 */
export function openRecorderDatabase(
  name: string = RECORDER_DATABASE,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, RECORDER_DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      for (const store of [...db.objectStoreNames])
        if (!(STORES as readonly string[]).includes(store))
          db.deleteObjectStore(store);
      if (!db.objectStoreNames.contains("events"))
        db.createObjectStore("events", { keyPath: ["trajectoryId", "seq"] });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (event.oldVersion > 0 && request.transaction)
        dropLeftovers(request.transaction);
    };
    request.onsuccess = () => {
      const db = request.result;
      // A newer copy of the extension upgrading the database is never blocked by this one.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () =>
      reject(
        request.error ??
          new Error("The Recorder database could not be opened."),
      );
    request.onblocked = () =>
      reject(
        new Error("The Recorder database is blocked by another open copy."),
      );
  });
}

/** Small promise helpers every caller uses instead of raw requests. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("An IndexedDB request failed."));
  });
}

/**
 * Runs `work` in one transaction and resolves its value once the transaction has committed. A throw or a rejection
 * from `work` aborts the transaction and rejects.
 */
export function tx<T>(
  db: IDBDatabase,
  stores: StoreName[],
  mode: IDBTransactionMode,
  work: (t: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    // `work` outcome: undefined until it settles
    let outcome:
      | { ok: true; value: T }
      | { ok: false; error: unknown }
      | undefined;
    let completed = false;
    let failed = false;
    let failure: unknown;
    const finish = () => {
      if (!completed || !outcome) return;
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };
    t.oncomplete = () => {
      completed = true;
      finish();
    };
    // A request error the caller handled still lets the transaction commit, so this only records the cause that
    // `onabort` reports; `finish` settles from the work outcome alone. t.error is still null while the error event
    // fires, so the cause is read from the failing request.
    t.onerror = (event) => {
      if (!failed) {
        failed = true;
        failure =
          (event.target as IDBRequest | null)?.error ??
          t.error ??
          new Error("An IndexedDB transaction failed.");
      }
    };
    t.onabort = () =>
      reject(
        failed
          ? failure
          : (t.error ?? new Error("An IndexedDB transaction was aborted.")),
      );
    const fail = (error: unknown) => {
      outcome = { ok: false, error };
      failed = true;
      failure = error;
      try {
        t.abort();
      } catch {
        // already finished; the abort handler or completion reports the failure
      }
      finish();
    };
    try {
      Promise.resolve(work(t)).then((value) => {
        outcome = { ok: true, value };
        finish();
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}
