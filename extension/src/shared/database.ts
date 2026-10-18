export const RECORDER_DATABASE = "openbot-recorder";
export const RECORDER_DATABASE_VERSION = 1;

/**
 * Every object store, created together in version 1:
 *  events  keyPath ["trajectoryId", "seq"]        the streamer's outbox
 *  meta    out-of-line string keys                 trajectory meta, "seq", "media:<demonstrationId>:<kind>" -> mediaId
 *  media   keyPath ["mediaId", "index"]            buffered screen and audio chunks, value { mediaId, index, blob }
 *  voice   keyPath ["demonstrationId", "index"]    untranscribed voice slices
 *  steps   keyPath ["demonstrationId", "index"]    steps not yet acknowledged by OpenBot
 *  bodies  keyPath ["mediaId", "line"]             network body lines not yet uploaded, value { mediaId, line, text };
 *          meta "media:<demonstrationId>:network" -> mediaId, "bodies-next:<mediaId>" -> the next line number and
 *          "bodies-progress:<mediaId>" -> { chunks, offset, inflight?, completed? }, how far OpenBot has taken the media
 * The step uploader also keeps meta "steps-next:<demonstrationId>" -> the next step index for that recording
 * (see stepsNextKey); deleteDemonstrationData removes it with the rest of the demonstration.
 */
export const STORES = [
  "events",
  "meta",
  "media",
  "voice",
  "steps",
  "bodies",
] as const;
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
        db.createObjectStore("media", { keyPath: ["mediaId", "index"] });
        db.createObjectStore("voice", {
          keyPath: ["demonstrationId", "index"],
        });
        db.createObjectStore("steps", {
          keyPath: ["demonstrationId", "index"],
        });
        db.createObjectStore("bodies", { keyPath: ["mediaId", "line"] });
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

const prefixRange = (prefix: string) =>
  IDBKeyRange.bound(prefix, `${prefix}\uffff`);
/** The meta key holding a demonstration's next step index; the step uploader and the delete share it. */
export const stepsNextKey = (demonstrationId: string) =>
  `steps-next:${demonstrationId}`;

const pairRange = (first: string) =>
  IDBKeyRange.bound([first, -Infinity], [first, Infinity]);

/**
 * Deletes every record of one demonstration in steps, voice and (through meta) media and bodies; Start over and the
 * person's own "Discard kept events" or Disconnect use it (a sign-out keeps the data).
 */
export async function deleteDemonstrationData(
  db: IDBDatabase,
  demonstrationId: string,
): Promise<void> {
  await tx(
    db,
    ["steps", "voice", "media", "bodies", "meta"],
    "readwrite",
    async (t) => {
      const meta = t.objectStore("meta");
      t.objectStore("steps").delete(pairRange(demonstrationId));
      t.objectStore("voice").delete(pairRange(demonstrationId));
      const linkRange = prefixRange(`media:${demonstrationId}:`);
      const linkKeys = await requestToPromise(meta.getAllKeys(linkRange));
      const mediaIds = await Promise.all(
        linkKeys.map((key) => requestToPromise(meta.get(key))),
      );
      for (const mediaId of mediaIds) {
        if (typeof mediaId !== "string") continue;
        t.objectStore("media").delete(pairRange(mediaId));
        t.objectStore("bodies").delete(pairRange(mediaId));
        meta.delete(`bodies-next:${mediaId}`);
        meta.delete(`bodies-progress:${mediaId}`);
      }
      meta.delete(linkRange);
      meta.delete(stepsNextKey(demonstrationId));
    },
  );
}

/**
 * Whether a demonstration's network bodies still owe OpenBot something: lines waiting in `bodies`, or every line
 * acknowledged but the media's `complete` not yet taken (its "bodies-progress:<mediaId>" record has chunks and is not
 * completed). Read-only.
 */
export async function networkBodiesOwed(
  db: IDBDatabase,
  demonstrationId: string,
): Promise<boolean> {
  return tx(db, ["bodies", "meta"], "readonly", async (t) => {
    const meta = t.objectStore("meta");
    const mediaId = await requestToPromise(
      meta.get(`media:${demonstrationId}:network`),
    );
    if (typeof mediaId !== "string") return false;
    const lines = await requestToPromise(
      t.objectStore("bodies").count(pairRange(mediaId)),
    );
    if (lines > 0) return true;
    const progress = (await requestToPromise(
      meta.get(`bodies-progress:${mediaId}`),
    )) as { chunks?: number; completed?: boolean } | undefined;
    return (progress?.chunks ?? 0) > 0 && !progress?.completed;
  });
}
