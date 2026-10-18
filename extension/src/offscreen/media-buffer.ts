import { openRecorderDatabase, requestToPromise, tx } from "../shared/database";

export type MediaKind = "screen" | "audio";

export type MediaBuffer = {
  /** Stores one chunk under the chunk index the server knows it by; a repeated index replaces the earlier chunk. */
  put(mediaId: string, index: number, blob: Blob): Promise<void>;
  /** Every buffered chunk of one media, in index order. The chunks stay until `remove` or `drop`. */
  take(mediaId: string): Promise<{ index: number; blob: Blob }[]>;
  remove(mediaId: string, index: number): Promise<void>;
  /** Deletes every buffered chunk of one media. */
  drop(mediaId: string): Promise<void>;
  /** The media id a demonstration's screen or audio was started under, if one was remembered. */
  mediaFor(
    demonstrationId: string,
    kind: MediaKind,
  ): Promise<string | undefined>;
  remember(
    demonstrationId: string,
    kind: MediaKind,
    mediaId: string,
  ): Promise<void>;
};

type StoredChunk = { mediaId: string; index: number; blob: Blob };

const mediaRange = (mediaId: string) =>
  IDBKeyRange.bound([mediaId, -Infinity], [mediaId, Infinity]);

const linkKey = (demonstrationId: string, kind: MediaKind) =>
  `media:${demonstrationId}:${kind}`;

/**
 * Screen and audio chunks waiting for OpenBot, in the shared Recorder database ("media" and "meta"; the schema lives
 * in database.ts).
 */
export async function openMediaBuffer(
  databaseName?: string,
): Promise<MediaBuffer> {
  const db = await openRecorderDatabase(databaseName);
  return {
    put: (mediaId, index, blob) =>
      tx(db, ["media"], "readwrite", (t) => {
        t.objectStore("media").put({ mediaId, index, blob });
      }),

    take: (mediaId) =>
      tx(db, ["media"], "readonly", async (t) => {
        const rows = (await requestToPromise(
          t.objectStore("media").getAll(mediaRange(mediaId)),
        )) as StoredChunk[];
        return rows.map(({ index, blob }) => ({ index, blob }));
      }),

    remove: (mediaId, index) =>
      tx(db, ["media"], "readwrite", (t) => {
        t.objectStore("media").delete([mediaId, index]);
      }),

    drop: (mediaId) =>
      tx(db, ["media"], "readwrite", (t) => {
        t.objectStore("media").delete(mediaRange(mediaId));
      }),

    mediaFor: (demonstrationId, kind) =>
      tx(db, ["meta"], "readonly", async (t) => {
        const mediaId = await requestToPromise(
          t.objectStore("meta").get(linkKey(demonstrationId, kind)),
        );
        return typeof mediaId === "string" ? mediaId : undefined;
      }),

    remember: (demonstrationId, kind, mediaId) =>
      tx(db, ["meta"], "readwrite", (t) => {
        t.objectStore("meta").put(mediaId, linkKey(demonstrationId, kind));
      }),
  };
}
