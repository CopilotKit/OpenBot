export const RECORDER_DATABASE = "openbot-recorder";
export const RECORDER_DATABASE_VERSION = 1;

/**
 * Every object store, created together in version 1:
 *  events  keyPath ["trajectoryId", "seq"]        the streamer's outbox
 *  meta    out-of-line string keys                 each trajectory's own record, and "seq", the last seq issued
 * Nothing else is kept in this browser: a recording's events wait here until Intelligence acknowledges them.
 */
export const STORES = ["events", "meta"] as const;
export type StoreName = (typeof STORES)[number];

/**
 * Opens (and on first use creates) the database; `name` lets tests use a fresh one per case. A later schema change
 * bumps the version here and adds its upgrade step here, never in a caller.
 */
export function openRecorderDatabase(
  name: string = RECORDER_DATABASE,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, RECORDER_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.length === 0) {
        db.createObjectStore("events", { keyPath: ["trajectoryId", "seq"] });
        db.createObjectStore("meta");
      }
    };
    request.onsuccess = () => resolve(request.result);
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
