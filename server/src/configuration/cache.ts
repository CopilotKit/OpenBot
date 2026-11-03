/**
 * One kind of record Intelligence holds for this deployment, held in memory per server instance.
 *
 * The same shape as the Bot directory (`agents/bot-registry/directory.ts`), for the same reason: these
 * records are read on every turn and every tool call (a Bot's grants, a person's instructions and
 * pauses, the component catalogue, the skills), so reading Intelligence each time would put a network
 * round trip under everything a person does. Each instance holds the whole set and reads it from
 * memory.
 *
 * FRESH ACROSS REPLICAS. A write made here is applied from Intelligence's answer at once, so this
 * instance reads its own writes. Others hear of it from the change announcement, which names the
 * record and its revision; the announcement is followed by a read of that one record. Announcements
 * can be lost, so the whole set is read again on every (re)join of the subscription and on a timer.
 * Revisions order what arrives: an older copy never replaces a newer one.
 *
 * GONE. A record Intelligence no longer has (removed, or read back at revision 0) leaves. One removed
 * since a full read began is not brought back by that read.
 */

export type RecordCache<R> = {
  /** Every record held. Never reaches Intelligence. */
  all(): R[];
  get(key: string): R | undefined;
  /** Keep what Intelligence answered, unless something newer is already held. */
  apply(record: R, confirmedAt?: number): R;
  /** Forget a record this instance knows is gone. */
  forget(key: string): void;
  /** Change every held record, in memory only, for a fact Intelligence already applied (a purge). */
  rewrite(change: (record: R) => R | null): void;
  /** An announcement: read the record unless the one held is already that new. */
  heard(key: string, revision: number): Promise<void>;
  /** Read one record from Intelligence now. */
  refresh(key: string): Promise<R | null>;
  /** Read the whole set again. */
  resync(): Promise<void>;
  /** Whether the first full read has completed. */
  loaded(): boolean;
};

export function createRecordCache<R>(options: {
  /** What the log calls it. */
  name: string;
  /** Every record, walking every page. */
  listAll: () => Promise<R[]>;
  /** One record, or null when Intelligence has none (gone, or never written). */
  read: (key: string) => Promise<R | null>;
  keyOf: (record: R) => string;
  revisionOf: (record: R) => number;
}): RecordCache<R> {
  const records = new Map<string, R>();
  const seenAt = new Map<string, number>();
  const goneAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<R | null>>();
  let resyncing: Promise<void> | undefined;
  let resyncAgain = false;
  let loaded = false;

  const apply = (record: R, confirmedAt = Date.now()): R => {
    const key = options.keyOf(record);
    const gone = goneAt.get(key);
    if (gone !== undefined && gone > confirmedAt) return record;
    goneAt.delete(key);
    seenAt.set(key, Math.max(seenAt.get(key) ?? 0, confirmedAt));
    const held = records.get(key);
    if (held && options.revisionOf(held) > options.revisionOf(record))
      return held;
    records.set(key, record);
    return record;
  };

  const forget = (key: string) => {
    records.delete(key);
    seenAt.delete(key);
    goneAt.set(key, Date.now());
  };

  const readThrough = (key: string): Promise<R | null> => {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const startedAt = Date.now();
    const read = options
      .read(key)
      .then((record) => {
        if (record) return apply(record, startedAt);
        if ((seenAt.get(key) ?? 0) <= startedAt) forget(key);
        return null;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, read);
    return read;
  };

  const readAll = async () => {
    const startedAt = Date.now();
    const everything = await options.listAll();
    const listed = new Set<string>();
    for (const record of everything) {
      listed.add(options.keyOf(record));
      apply(record, startedAt);
    }
    // Held, absent from a complete read, and not confirmed since that read began: gone.
    for (const key of [...records.keys()]) {
      if (listed.has(key)) continue;
      if ((seenAt.get(key) ?? 0) >= startedAt) continue;
      forget(key);
    }
    loaded = true;
  };

  return {
    all: () => [...records.values()],
    get: (key) => records.get(key),
    apply,
    forget,
    rewrite(change) {
      for (const [key, record] of [...records]) {
        const next = change(record);
        if (next === null) records.delete(key);
        else if (next !== record) records.set(key, next);
      }
    },
    async heard(key, revision) {
      try {
        const held = records.get(key);
        if (held && options.revisionOf(held) >= revision) return;
        await readThrough(key);
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: `${options.name}-change-read-failed`,
            key,
            note: "The next full read picks the change up.",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    },
    refresh: readThrough,
    resync() {
      if (resyncing) {
        resyncAgain = true;
        return resyncing;
      }
      resyncing = (async () => {
        try {
          do {
            resyncAgain = false;
            await readAll();
          } while (resyncAgain);
        } finally {
          resyncing = undefined;
        }
      })();
      return resyncing;
    },
    loaded: () => loaded,
  };
}
