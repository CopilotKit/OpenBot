import type {
  CapturedEvent,
  JsonValue,
} from "@openbot/shared/recorder-masking";
import { openRecorderDatabase, requestToPromise, tx } from "../shared/database";

export type OutboxEvent = {
  trajectoryId: string;
  seq: number;
  event: CapturedEvent & { value: Record<string, JsonValue> };
  bytes: number;
};

/** One trajectory's own record in the meta store. */
export type TrajectoryMeta = {
  recordingId: string;
  title: string;
  pushed: number;
  outcomeQueued: boolean;
  droppedPending: number;
  stopped: boolean;
  /** Rollover: the trajectory this one continues in. */
  next?: string;
};

/** The meta key prefix a trajectory's own record lives under; `trajectories()` counts these as well as stored events. */
export const TRAJECTORY_META_PREFIX = "trajectory:";

export const trajectoryMetaKey = (trajectoryId: string) =>
  `${TRAJECTORY_META_PREFIX}${trajectoryId}`;

export type Outbox = {
  put(item: OutboxEvent): Promise<void>;
  oldest(
    trajectoryId: string,
    maxEvents: number,
    maxBytes: number,
  ): Promise<OutboxEvent[]>;
  remove(trajectoryId: string, seqs: number[]): Promise<void>;
  count(trajectoryId: string): Promise<number>;
  clear(trajectoryId: string): Promise<void>;
  /** Every trajectory with events or meta. */
  trajectories(): Promise<string[]>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta<T>(key: string, value: T): Promise<void>;
};

const trajectoryRange = (trajectoryId: string) =>
  IDBKeyRange.bound([trajectoryId, -Infinity], [trajectoryId, Infinity]);

/**
 * The streamer's durable outbox in the shared Recorder database ("events" and "meta"; the schema lives in
 * database.ts). `put` uses IndexedDB `add`, so a reused [trajectoryId, seq] rejects instead of replacing an event.
 */
export async function openOutbox(databaseName?: string): Promise<Outbox> {
  const db = await openRecorderDatabase(databaseName);
  return {
    put: (item) =>
      tx(db, ["events"], "readwrite", (t) => {
        t.objectStore("events").add(item);
      }),

    oldest: (trajectoryId, maxEvents, maxBytes) =>
      tx(
        db,
        ["events"],
        "readonly",
        (t) =>
          new Promise<OutboxEvent[]>((resolve, reject) => {
            const found: OutboxEvent[] = [];
            let bytes = 0;
            const request = t
              .objectStore("events")
              .openCursor(trajectoryRange(trajectoryId));
            request.onerror = () =>
              reject(request.error ?? new Error("The outbox read failed."));
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) return resolve(found);
              const next = cursor.value as OutboxEvent;
              // A lone event larger than the byte limit still goes out by itself, so it cannot stall the queue.
              if (
                found.length >= maxEvents ||
                (found.length > 0 && bytes + next.bytes > maxBytes)
              ) {
                return resolve(found);
              }
              found.push(next);
              bytes += next.bytes;
              cursor.continue();
            };
          }),
      ),

    remove: (trajectoryId, seqs) =>
      tx(db, ["events"], "readwrite", (t) => {
        const store = t.objectStore("events");
        for (const seq of seqs) store.delete([trajectoryId, seq]);
      }),

    count: (trajectoryId) =>
      tx(db, ["events"], "readonly", (t) =>
        requestToPromise(
          t.objectStore("events").count(trajectoryRange(trajectoryId)),
        ),
      ),

    clear: (trajectoryId) =>
      tx(db, ["events", "meta"], "readwrite", (t) => {
        t.objectStore("events").delete(trajectoryRange(trajectoryId));
        t.objectStore("meta").delete(trajectoryMetaKey(trajectoryId));
      }),

    trajectories: () =>
      tx(db, ["events", "meta"], "readonly", async (t) => {
        const ids = new Set<string>();
        const eventKeys = await requestToPromise(
          t.objectStore("events").getAllKeys(),
        );
        for (const key of eventKeys) ids.add((key as [string, number])[0]);
        const metaKeys = await requestToPromise(
          t
            .objectStore("meta")
            .getAllKeys(
              IDBKeyRange.bound(
                TRAJECTORY_META_PREFIX,
                `${TRAJECTORY_META_PREFIX}\uffff`,
              ),
            ),
        );
        for (const key of metaKeys) {
          ids.add(String(key).slice(TRAJECTORY_META_PREFIX.length));
        }
        return [...ids];
      }),

    getMeta: <T>(key: string) =>
      tx(db, ["meta"], "readonly", (t) =>
        requestToPromise(t.objectStore("meta").get(key)),
      ) as Promise<T | undefined>,

    setMeta: (key, value) =>
      tx(db, ["meta"], "readwrite", (t) => {
        t.objectStore("meta").put(value, key);
      }),
  };
}
