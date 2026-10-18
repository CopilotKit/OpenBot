import {
  type MediaRecord,
  networkBodyRef,
  RECORDER_MEDIA_CHUNK_BYTES,
  RECORDER_NETWORK_BODY_MAX_BYTES,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import {
  openRecorderDatabase,
  requestToPromise,
  tx,
} from "../../shared/database";
import {
  OpenBotError,
  openbotJson,
  openbotRaw,
} from "../../shared/openbot-client";
import type { DrainRecord } from "../../shared/storage";
import type { RecordingContext } from "./index";

/** One side of a request, already masked. A body past RECORDER_NETWORK_BODY_MAX_BYTES is stored as its first
 * 2 MiB with `status: "truncated"` and its full size in `bytes` (Decision 5); callers leave both fields unset. */
export type NetworkBodySide = {
  headers: Record<string, string>;
  body?: string;
  status?: "truncated";
  bytes?: number;
};
export type NetworkBodyRecord = {
  requestId: string;
  url: string;
  method: string;
  status: number;
  request: NetworkBodySide;
  response: NetworkBodySide;
};

export type BodyStore = {
  /** Resolves to the record's bodyRef once its line is in IndexedDB. Rejects when the media cannot be created. */
  add(record: NetworkBodyRecord): Promise<string>;
  /** Uploads every line still in IndexedDB; rejects when OpenBot does not take them (they stay for the next try). */
  flush(): Promise<void>;
  /** Flushes and completes the media. */
  close(): Promise<void>;
  /** After a service-worker restart: uploads whatever lines the last worker left in IndexedDB. */
  resume(): Promise<void>;
};
type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
type Deps = { db?: () => Promise<IDBDatabase>; timers?: Timers };

const FLUSH_AFTER_MS = 5_000;
const MEDIA_TIMEOUT_MS = 15_000;
const CHUNK_TIMEOUT_MS = 30_000;
const NETWORK_MIME = "application/x-ndjson";

/** Where a media's upload stands: `chunks` acknowledged so far, `offset` bytes of the first stored line already
 * acknowledged, and the length of a chunk taken but not yet acknowledged (so a resend has the same index and bytes). */
type Progress = { chunks: number; offset: number; inflight?: number };
const linkKey = (demonstrationId: string) => `media:${demonstrationId}:network`;
const nextKey = (mediaId: string) => `bodies-next:${mediaId}`;
const progressKey = (mediaId: string) => `bodies-progress:${mediaId}`;
const lineRange = (mediaId: string) =>
  IDBKeyRange.bound([mediaId, -Infinity], [mediaId, Infinity]);

const encoder = new TextEncoder();

function capBody(side: NetworkBodySide): NetworkBodySide {
  if (side.body === undefined) return side;
  const bytes = encoder.encode(side.body);
  if (bytes.length <= RECORDER_NETWORK_BODY_MAX_BYTES) return side;
  let end = RECORDER_NETWORK_BODY_MAX_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    ...side,
    body: new TextDecoder().decode(bytes.subarray(0, end)),
    status: "truncated",
    bytes: bytes.length,
  };
}

async function readProgress(
  db: IDBDatabase,
  mediaId: string,
): Promise<Progress> {
  const stored = await tx(db, ["meta"], "readonly", (t) =>
    requestToPromise<Progress | undefined>(
      t.objectStore("meta").get(progressKey(mediaId)),
    ),
  );
  return stored ?? { chunks: 0, offset: 0 };
}

type Row = { line: number; size: number; bytes: Uint8Array };

/** The stored lines from the oldest, stopping once `wantBytes` of them are read. */
function readRows(
  db: IDBDatabase,
  mediaId: string,
  wantBytes: number,
): Promise<Row[]> {
  return tx(
    db,
    ["bodies"],
    "readonly",
    (t) =>
      new Promise<Row[]>((resolve, reject) => {
        const rows: Row[] = [];
        let total = 0;
        const request = t.objectStore("bodies").openCursor(lineRange(mediaId));
        request.onerror = () =>
          reject(request.error ?? new Error("Reading the body lines failed."));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(rows);
          const row = cursor.value as { line: number; text: string };
          const bytes = encoder.encode(`${row.text}\n`);
          rows.push({ line: row.line, size: bytes.length, bytes });
          total += bytes.length;
          if (total >= wantBytes) return resolve(rows);
          cursor.continue();
        };
      }),
  );
}

type Chunk = {
  index: number;
  bytes: Uint8Array<ArrayBuffer>;
  /** Lines whose last byte is in this chunk, and where the next chunk starts inside the first line left. */
  done: number[];
  offset: number;
};

/** The next chunk of a media's pending bytes: the one already in flight when there is one, else a full 512 KiB, or
 * whatever is there when `all`. Its length is persisted before it is returned. */
async function takeChunk(
  db: IDBDatabase,
  mediaId: string,
  all: boolean,
): Promise<Chunk | null> {
  const progress = await readProgress(db, mediaId);
  const wanted = progress.inflight ?? RECORDER_MEDIA_CHUNK_BYTES;
  const rows = await readRows(db, mediaId, progress.offset + wanted);
  const available = rows.reduce((n, row) => n + row.size, 0) - progress.offset;
  const length = progress.inflight ?? Math.min(wanted, available);
  if (length <= 0) return null;
  if (
    progress.inflight === undefined &&
    length < RECORDER_MEDIA_CHUNK_BYTES &&
    !all
  )
    return null;
  const joined = new Uint8Array(available + progress.offset);
  let at = 0;
  for (const row of rows) {
    joined.set(row.bytes, at);
    at += row.size;
  }
  const end = progress.offset + length;
  const done: number[] = [];
  let consumed = end;
  for (const row of rows) {
    if (consumed < row.size) break;
    consumed -= row.size;
    done.push(row.line);
  }
  if (progress.inflight === undefined) {
    await tx(db, ["meta"], "readwrite", (t) => {
      t.objectStore("meta").put(
        { ...progress, inflight: length },
        progressKey(mediaId),
      );
    });
  }
  return {
    index: progress.chunks,
    bytes: joined.slice(progress.offset, end),
    done,
    offset: consumed,
  };
}

async function acknowledge(
  db: IDBDatabase,
  mediaId: string,
  chunk: Chunk,
): Promise<void> {
  await tx(db, ["bodies", "meta"], "readwrite", (t) => {
    const bodies = t.objectStore("bodies");
    for (const line of chunk.done) bodies.delete([mediaId, line]);
    t.objectStore("meta").put(
      { chunks: chunk.index + 1, offset: chunk.offset } satisfies Progress,
      progressKey(mediaId),
    );
  });
}

type Target = { openbotUrl: string; token: string; demonstrationId: string };

async function putChunk(
  target: Target,
  mediaId: string,
  chunk: Chunk,
): Promise<void> {
  const response = await openbotRaw(
    target,
    recorderPaths.mediaChunk(target.demonstrationId, mediaId, chunk.index),
    {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: chunk.bytes,
      signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
    },
  );
  if (!response.ok)
    throw new OpenBotError(
      response.status,
      `OpenBot answered ${response.status} for a network body chunk.`,
      null,
    );
}

/** Uploads a media's pending bytes in numbered chunks, deleting each chunk's lines once OpenBot acknowledged it.
 * Returns the bytes acknowledged. */
async function uploadPending(
  db: IDBDatabase,
  target: Target,
  mediaId: string,
  all: boolean,
): Promise<number> {
  let sent = 0;
  for (;;) {
    const chunk = await takeChunk(db, mediaId, all);
    if (!chunk) return sent;
    await putChunk(target, mediaId, chunk);
    await acknowledge(db, mediaId, chunk);
    sent += chunk.bytes.length;
  }
}

async function completeMedia(
  db: IDBDatabase,
  target: Target,
  mediaId: string,
): Promise<void> {
  const { chunks } = await readProgress(db, mediaId);
  await openbotJson<{ media: MediaRecord }>(
    target,
    recorderPaths.mediaComplete(target.demonstrationId, mediaId),
    {
      body: { chunkCount: chunks },
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
    },
  );
}

async function linkedMedia(
  db: IDBDatabase,
  demonstrationId: string,
): Promise<string | null> {
  const mediaId = await tx(db, ["meta"], "readonly", (t) =>
    requestToPromise<unknown>(
      t.objectStore("meta").get(linkKey(demonstrationId)),
    ),
  );
  return typeof mediaId === "string" ? mediaId : null;
}

type Ledger = { mediaId: string; next: number; pending: number };
type State = {
  demonstrationId: string;
  ready: Promise<Ledger>;
  /** Lines are written one after another, so a failed write never leaves a gap in the media's line numbers. */
  writes: Promise<unknown>;
  closed: boolean;
};

/**
 * One `network` media per demonstration (NDJSON, one masked request per line), created on the first body. Each line
 * is written to IndexedDB (`bodies`) before `add` resolves, so its bodyRef survives a service-worker restart or a
 * browser crash; lines leave IndexedDB only once the chunk holding them is acknowledged by OpenBot.
 */
export function createBodyStore(
  target: () => RecordingContext | null,
  deps: Deps = {},
): BodyStore {
  const openDb = deps.db ?? (() => openRecorderDatabase());
  const timers: Timers = deps.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let state: State | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: unknown = null;

  const ledgerFor = async (mediaId: string): Promise<Ledger> => {
    const db = await openDb();
    const [next, rows] = await Promise.all([
      tx(db, ["meta"], "readonly", (t) =>
        requestToPromise<unknown>(t.objectStore("meta").get(nextKey(mediaId))),
      ),
      readRows(db, mediaId, Number.POSITIVE_INFINITY),
    ]);
    const progress = await readProgress(db, mediaId);
    return {
      mediaId,
      next: typeof next === "number" ? next : 0,
      pending: rows.reduce((n, row) => n + row.size, 0) - progress.offset,
    };
  };

  const stateFor = (context: RecordingContext): State => {
    if (state && state.demonstrationId === context.demonstrationId)
      return state;
    const created: State = {
      demonstrationId: context.demonstrationId,
      writes: Promise.resolve(),
      closed: false,
      ready: (async () => {
        const db = await openDb();
        const existing = await linkedMedia(db, context.demonstrationId);
        if (existing) return ledgerFor(existing);
        const { media } = await openbotJson<{ media: MediaRecord }>(
          context,
          recorderPaths.media(context.demonstrationId),
          {
            body: { kind: "network", mimeType: NETWORK_MIME },
            signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
          },
        );
        await tx(db, ["meta"], "readwrite", (t) => {
          t.objectStore("meta").put(media.id, linkKey(context.demonstrationId));
          t.objectStore("meta").put(0, nextKey(media.id));
        });
        return { mediaId: media.id, next: 0, pending: 0 };
      })(),
    };
    state = created;
    // A media that could not be created is tried again by the next add.
    created.ready.catch(() => {
      if (state === created) state = null;
    });
    return created;
  };

  /** The state of the live recording when it already has a media (this worker's or an earlier one's), else null. */
  const adopt = async (context: RecordingContext): Promise<State | null> => {
    if (state && state.demonstrationId === context.demonstrationId)
      return state;
    const db = await openDb();
    if (!(await linkedMedia(db, context.demonstrationId))) return null;
    return stateFor(context);
  };

  const upload = (all: boolean): Promise<void> => {
    const run = queue.then(async () => {
      const context = target();
      const current = state;
      if (
        !context ||
        !current ||
        current.demonstrationId !== context.demonstrationId
      )
        return;
      const ledger = await current.ready;
      const db = await openDb();
      ledger.pending -= await uploadPending(db, context, ledger.mediaId, all);
    });
    queue = run.catch(() => {});
    return run;
  };

  const arm = () => {
    if (timer !== null) return;
    timer = timers.set(() => {
      timer = null;
      // Lines that did not go up stay in IndexedDB; the next timer, flush or close tries again.
      upload(true).catch(() => arm());
    }, FLUSH_AFTER_MS);
  };

  const add = async (record: NetworkBodyRecord): Promise<string> => {
    const context = target();
    if (!context) throw new Error("No recording is running.");
    const current = stateFor(context);
    const ledger = await current.ready;
    const text = JSON.stringify({
      ...record,
      request: capBody(record.request),
      response: capBody(record.response),
    });
    const write = current.writes.then(async () => {
      const db = await openDb();
      const line = ledger.next;
      await tx(db, ["bodies", "meta"], "readwrite", (t) => {
        t.objectStore("bodies").put({ mediaId: ledger.mediaId, line, text });
        t.objectStore("meta").put(line + 1, nextKey(ledger.mediaId));
      });
      ledger.next = line + 1;
      ledger.pending += encoder.encode(text).length + 1;
      return line;
    });
    current.writes = write.catch(() => {});
    const line = await write;
    if (ledger.pending >= RECORDER_MEDIA_CHUNK_BYTES)
      upload(false).catch(() => arm());
    arm();
    return networkBodyRef(
      context.openbotUrl,
      context.demonstrationId,
      ledger.mediaId,
      line,
    );
  };

  return {
    add,
    flush: async () => {
      if (timer !== null) timers.clear(timer);
      timer = null;
      await upload(true);
    },
    close: async () => {
      if (timer !== null) timers.clear(timer);
      timer = null;
      const context = target();
      if (!context) return;
      const current = await adopt(context);
      if (!current || current.closed) return;
      await upload(true);
      const ledger = await current.ready;
      await completeMedia(await openDb(), context, ledger.mediaId);
      current.closed = true;
    },
    resume: async () => {
      const context = target();
      if (!context) return;
      if (!(await adopt(context))) return;
      await upload(true);
    },
  };
}

/** After a browser restart: uploads the network body lines a drained recording still has in IndexedDB, in line order
 * and none twice, and completes its media. A no-op (no request) when nothing is buffered for it. */
export async function recoverNetworkBodies(
  drain: DrainRecord,
  target: { openbotUrl: string; token: string },
  deps: { db?: () => Promise<IDBDatabase> } = {},
): Promise<void> {
  const opened = deps.db ? null : await openRecorderDatabase();
  const db = opened ?? (await (deps.db as () => Promise<IDBDatabase>)());
  try {
    const mediaId = await linkedMedia(db, drain.demonstrationId);
    if (!mediaId) return;
    const rows = await readRows(db, mediaId, 1);
    if (rows.length === 0) return;
    const full = { ...target, demonstrationId: drain.demonstrationId };
    await uploadPending(db, full, mediaId, true);
    await completeMedia(db, full, mediaId);
  } finally {
    opened?.close();
  }
}
