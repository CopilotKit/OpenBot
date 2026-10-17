import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";
import { recorderPaths } from "@openbot/shared/recorder-api";
import { requestToPromise, tx } from "../shared/database";
import { OpenBotError, openbotJson } from "../shared/openbot-client";

export type StepTarget = {
  openbotUrl: string;
  token: string;
  demonstrationId: string;
};

type SignedOutReason = "revoked" | "removed" | "organization";

/** Flush once this many steps are waiting, or this long after the first one. */
const FLUSH_AT = 20;
const FLUSH_AFTER_MS = 3_000;
/** One request carries at most this many actions and this many bytes of JSON. */
const BATCH_ACTIONS = 50;
const BATCH_BYTES = 200 * 1024;
const RETRY_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

type StepRecord = {
  demonstrationId: string;
  index: number;
  action: DemonstrationAction;
};

const pairRange = (id: string, from = -Infinity, to = Infinity) =>
  IDBKeyRange.bound([id, from], [id, to]);
const nextKey = (id: string) => `steps-next:${id}`;

/**
 * Pending steps live in IndexedDB (store "steps", key [demonstrationId, index]), because storage.session is cleared by
 * a browser restart and holds only 10 MB. `add` gives a step its index at once and writes it before anything is
 * uploaded; OpenBot's acknowledgement deletes it. A failed upload never discards a step.
 *
 * `flush` and `drain` resolve once nothing is queued and reject otherwise, after the callback or the scheduled retry
 * that handles the failure has already run. `onRefused` is only for the live path: `drain` leaves a refusal to its
 * caller.
 */
export function createStepUploader(deps: {
  target(): StepTarget | null;
  db(): Promise<IDBDatabase>;
  onSignedOut(reason: SignedOutReason): Promise<void>;
  /** The server refused the batch: the recording was stopped there (Task 13's Stop). */
  onRefused(message: string): Promise<void>;
  timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}): {
  load(): Promise<void>;
  add(action: DemonstrationAction): void;
  flush(): Promise<void>;
  /** Uploads every queued step of one demonstration (browser-restart recovery), whatever the in-memory state. */
  drain(target: StepTarget): Promise<void>;
  reset(demonstrationId: string): Promise<void>;
  count(): number;
} {
  const timers = deps.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clear: (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  const next = new Map<string, number>();
  const pending = new Map<string, number>();
  let writes: Promise<void> = Promise.resolve();
  let writeFailure: { error: unknown } | null = null;
  let flushTimer: unknown = null;
  let retryTimer: unknown = null;
  let attempt = 0;
  // The token a sign-out or refusal was reported for: nothing more is uploaded with it.
  let haltedToken: string | null = null;
  let running: Promise<void> = Promise.resolve();

  const clearTimer = (handle: unknown) => {
    if (handle !== null) timers.clear(handle);
  };

  async function readBatch(
    db: IDBDatabase,
    demonstrationId: string,
  ): Promise<StepRecord[]> {
    const rows = await tx(db, ["steps"], "readonly", (t) =>
      requestToPromise<StepRecord[]>(
        t
          .objectStore("steps")
          .getAll(pairRange(demonstrationId), BATCH_ACTIONS),
      ),
    );
    const batch: StepRecord[] = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += JSON.stringify(row.action).length;
      if (batch.length > 0 && bytes > BATCH_BYTES) break;
      batch.push(row);
    }
    return batch;
  }

  async function removeSteps(
    db: IDBDatabase,
    demonstrationId: string,
    from: number,
    to: number,
  ): Promise<void> {
    await tx(db, ["steps"], "readwrite", (t) => {
      t.objectStore("steps").delete(pairRange(demonstrationId, from, to));
    });
    pending.set(
      demonstrationId,
      Math.max(0, (pending.get(demonstrationId) ?? 0) - (to - from + 1)),
    );
  }

  /** Sends batches until the demonstration has none queued. Throws what the last request threw. */
  async function upload(target: StepTarget): Promise<void> {
    const db = await deps.db();
    for (;;) {
      const batch = await readBatch(db, target.demonstrationId);
      const first = batch[0];
      const last = batch[batch.length - 1];
      if (!first || !last) {
        pending.set(target.demonstrationId, 0);
        return;
      }
      try {
        await openbotJson(
          target,
          recorderPaths.actions(target.demonstrationId),
          {
            body: {
              fromIndex: first.index,
              actions: batch.map((row) => row.action),
            },
          },
        );
      } catch (error) {
        const count =
          error instanceof OpenBotError && error.status === 409
            ? error.body?.count
            : undefined;
        if (typeof count === "number" && count > first.index) {
          // OpenBot already holds the steps below `count`: drop them and resend from it.
          await removeSteps(db, target.demonstrationId, first.index, count - 1);
          continue;
        }
        throw error;
      }
      await removeSteps(db, target.demonstrationId, first.index, last.index);
    }
  }

  /** What a failed request means: a sign-out, a refusal, or a failure worth retrying. */
  async function classify(
    error: unknown,
    target: StepTarget,
    live: boolean,
  ): Promise<void> {
    if (error instanceof OpenBotError) {
      if (error.signedOut) {
        haltedToken = target.token;
        await deps.onSignedOut(error.body?.reason ?? "removed");
        return;
      }
      const refused =
        error.status === 409 ||
        (error.status >= 400 &&
          error.status < 500 &&
          error.status !== 401 &&
          error.status !== 408 &&
          error.status !== 429);
      if (refused) {
        if (live) {
          haltedToken = target.token;
          await deps.onRefused(error.message);
        }
        return;
      }
    }
    if (live) scheduleRetry();
  }

  function scheduleRetry(): void {
    if (retryTimer !== null) return;
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 30_000;
    attempt += 1;
    retryTimer = timers.set(() => {
      retryTimer = null;
      void flush().catch(() => {
        // The failure was already reported or has scheduled the next retry.
      });
    }, delay);
  }

  async function attemptUpload(target: StepTarget, live: boolean) {
    try {
      await upload(target);
      attempt = 0;
      clearTimer(retryTimer);
      retryTimer = null;
    } catch (error) {
      await classify(error, target, live);
      throw error;
    }
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = running.then(work);
    running = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function flush(): Promise<void> {
    await writes;
    clearTimer(flushTimer);
    flushTimer = null;
    if (writeFailure) {
      const { error } = writeFailure;
      writeFailure = null;
      throw error;
    }
    return serial(async () => {
      const target = deps.target();
      if (!target || target.token === haltedToken) return;
      await attemptUpload(target, true);
    });
  }

  function schedule(demonstrationId: string): void {
    if (retryTimer !== null) return;
    if ((pending.get(demonstrationId) ?? 0) >= FLUSH_AT) {
      void flush().catch(() => {
        // Reported or retried inside flush.
      });
      return;
    }
    if (flushTimer === null) {
      flushTimer = timers.set(() => {
        flushTimer = null;
        void flush().catch(() => {
          // Reported or retried inside flush.
        });
      }, FLUSH_AFTER_MS);
    }
  }

  return {
    async load() {
      const target = deps.target();
      if (!target) return;
      const id = target.demonstrationId;
      const db = await deps.db();
      const [stored, rows] = await tx(db, ["meta", "steps"], "readonly", (t) =>
        Promise.all([
          requestToPromise<unknown>(t.objectStore("meta").get(nextKey(id))),
          requestToPromise<StepRecord[]>(
            t.objectStore("steps").getAll(pairRange(id)),
          ),
        ]),
      );
      const lastIndex = rows[rows.length - 1]?.index ?? -1;
      next.set(
        id,
        Math.max(typeof stored === "number" ? stored : 0, lastIndex + 1),
      );
      pending.set(id, rows.length);
      if (rows.length > 0) schedule(id);
    },

    add(action) {
      const target = deps.target();
      if (!target) throw new Error("No recording is open to add a step to.");
      const id = target.demonstrationId;
      const index = next.get(id) ?? 0;
      next.set(id, index + 1);
      const record: StepRecord = { demonstrationId: id, index, action };
      writes = writes.then(async () => {
        try {
          const db = await deps.db();
          await tx(db, ["steps", "meta"], "readwrite", (t) => {
            t.objectStore("steps").put(record);
            t.objectStore("meta").put(index + 1, nextKey(id));
          });
          pending.set(id, (pending.get(id) ?? 0) + 1);
          schedule(id);
        } catch (error) {
          writeFailure = { error };
        }
      });
    },

    flush,

    async drain(target) {
      await writes;
      await serial(() => attemptUpload(target, false));
    },

    async reset(demonstrationId) {
      await writes;
      clearTimer(flushTimer);
      flushTimer = null;
      clearTimer(retryTimer);
      retryTimer = null;
      attempt = 0;
      const db = await deps.db();
      await tx(db, ["steps", "meta"], "readwrite", (t) => {
        t.objectStore("steps").delete(pairRange(demonstrationId));
        t.objectStore("meta").delete(nextKey(demonstrationId));
      });
      next.delete(demonstrationId);
      pending.delete(demonstrationId);
    },

    count() {
      const target = deps.target();
      return target ? (next.get(target.demonstrationId) ?? 0) : 0;
    },
  };
}
