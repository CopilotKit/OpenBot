/**
 * What a Bot's screen looked like when it opened a page.
 *
 * Written where the navigation happens, which is the one moment the screen is certainly showing the
 * page that was asked for, and read back when somebody reopens the conversation that asked for it.
 *
 * Kept in Intelligence's file store, as a file of purpose {@link PAGE_FRAME_PURPOSE}: its
 * `collection` is the computer (or seat) it was taken on, its `key` the turn, its `sourceUrl` the
 * page and its `title` the page's title. The picture is stored as the image bytes it is; the base64
 * this module takes and gives back is only how the computer and the browser carry it.
 */
import {
  FileExistsError,
  filesClient,
  filesIdempotencyKey,
} from "../files/client";

/** The file store purpose a turn's screenshot is kept under. */
export const PAGE_FRAME_PURPOSE = "page_frame";

/**
 * A screenshot, and the ceiling on one.
 *
 * Generous enough for a full page at the sizes a computer runs, small enough that nothing can push
 * megabytes into the store. Refused rather than truncated, because half a PNG is not a smaller
 * picture, it is a broken one.
 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * How long a turn's screenshot is kept.
 *
 * A month, because reading back a conversation is the thing these exist for and people do that long
 * after the run. Past that the transcript names the page it opened instead, which is the same
 * sentence with less in it rather than a broken one.
 */
export const FRAME_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How big a base64 string actually is, in bytes.
 *
 * `String.length` counts characters, which is the same number only while every character is ASCII.
 * Base64 is ASCII, so the two agree today; measuring the thing the limit is named for means they
 * cannot quietly stop agreeing.
 */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function tooLarge(value: string): boolean {
  return byteLength(value) > MAX_FRAME_BYTES;
}

/** The image type of a frame's bytes, from their signature. */
function imageTypeOf(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

export type PageFrameStore = {
  save: (frame: {
    computerId: string;
    toolCallId: string;
    url: string;
    title?: string;
    frame: string;
    /** When the frame was taken. Now, unless an older record is being carried over. */
    capturedAt?: Date;
  }) => Promise<void>;
  load: (
    computerId: string,
    toolCallId: string,
  ) => Promise<{ url: string; title: string | null; frame: string } | null>;
  /**
   * Everything kept for one seat, or for every seat on one computer. Returns how many went.
   *
   * Called when a profile is wiped, because "every login the Bot had is gone" is not true while
   * pictures of the signed-in pages are still readable from the transcript. Given a computer
   * (`person:<id>`) it takes every seat filed under it (`person:<id>/<bot>`), which is what wiping a
   * person's whole computer wipes.
   */
  clear: (computerId: string) => Promise<number>;
  /**
   * Frames older than the retention window, across every computer. Returns how many went.
   *
   * A page is a distinct frame, so a Bot that browses grows the store for as long as it runs, and
   * screenshots are the largest thing this deployment stores and the least useful once nobody is
   * reading that conversation any more. Every frame also carries its own expiry — the moment it was
   * taken plus {@link FRAME_RETENTION_MS} — and Intelligence removes it then, on every deployment
   * whatever its computers' mode. This removes, by age, whatever a window shorter than that leaves.
   */
  purge: (olderThanMs: number) => Promise<number>;
};

export function createPageFrameStore(): PageFrameStore {
  return {
    async save(input) {
      if (!input.toolCallId || !input.url) return;
      if (tooLarge(input.frame)) {
        /*
         * Said out loud rather than dropped in silence. A turn with no picture falls back to naming
         * its page, which looks exactly like a turn nobody photographed, so without this line a
         * deployment whose pages are all too big has no way to find that out.
         */
        console.warn(
          `[computer] a frame of ${input.url} was ${byteLength(input.frame)} bytes and was not kept; the limit is ${MAX_FRAME_BYTES}.`,
        );
        return;
      }
      const bytes = Buffer.from(input.frame, "base64");
      const capturedAt = input.capturedAt ?? new Date();
      try {
        await filesClient().create(
          {
            purpose: PAGE_FRAME_PURPOSE,
            collection: input.computerId,
            key: input.toolCallId,
            name: "frame",
            contentType: imageTypeOf(bytes),
            title: input.title ? input.title : null,
            sourceUrl: input.url,
            expiresAt: new Date(capturedAt.getTime() + FRAME_RETENTION_MS),
            ...(input.capturedAt ? { createdAt: input.capturedAt } : {}),
          },
          bytes,
          filesIdempotencyKey("page-frame"),
        );
      } catch (error) {
        /*
         * Written once. A turn happens once and is then over for good, so a second write for the
         * same turn is either a retry of the same thing — which Intelligence answers with the frame
         * already kept — or a mistake, and neither should change what a past turn shows. Letting the
         * newer win is what made the record mutable before.
         */
        if (error instanceof FileExistsError) return;
        throw error;
      }
    },

    async load(computerId, toolCallId) {
      // A frame is only ever kept under a turn and a computer, so a blank one names nothing.
      if (!computerId || !toolCallId) return null;
      /*
       * Both, always. A caller who may reach one Bot must not be able to read another Bot's screen
       * by naming a turn: the Bot in the path is what the route already checked, so it is what this
       * is keyed on too — the computer is the collection and the turn the key, matched exactly.
       */
      const [file] = await filesClient().list({
        purpose: PAGE_FRAME_PURPOSE,
        collection: computerId,
        key: toolCallId,
      });
      if (!file?.sourceUrl) return null;
      const bytes = await filesClient().content(file.id);
      if (!bytes) return null;
      return {
        url: file.sourceUrl,
        title: file.title,
        frame: bytes.toString("base64"),
      };
    },

    async clear(computerId) {
      return filesClient().purge({
        purpose: PAGE_FRAME_PURPOSE,
        collectionPrefix: computerId,
      });
    },

    async purge(olderThanMs) {
      return filesClient().purge({
        purpose: PAGE_FRAME_PURPOSE,
        createdBefore: new Date(Date.now() - olderThanMs).toISOString(),
      });
    },
  };
}
