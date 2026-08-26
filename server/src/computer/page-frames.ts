/**
 * What a Bot's screen looked like when it opened a page.
 *
 * Written where the navigation happens, which is the one moment the screen is certainly showing the
 * page that was asked for, and read back when somebody reopens the conversation that asked for it.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { computerPageFrame } from "../db/schema";

/**
 * A screenshot, and the ceiling on one.
 *
 * Generous enough for a full page at the sizes a computer runs, small enough that nothing can push
 * megabytes into the store. Refused rather than truncated, because half a PNG is not a smaller
 * picture, it is a broken one.
 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

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

export type PageFrameStore = {
  save: (frame: {
    computerId: string;
    toolCallId: string;
    url: string;
    title?: string;
    frame: string;
  }) => Promise<void>;
  load: (
    computerId: string,
    toolCallId: string,
  ) => Promise<{ url: string; title: string | null; frame: string } | null>;
  /**
   * Everything kept for one computer. Returns how many went.
   *
   * Called when a profile is wiped, because "every login the Bot had is gone" is not true while
   * pictures of the signed-in pages are still readable from the transcript.
   */
  clear: (computerId: string) => Promise<number>;
  /**
   * Frames older than the retention window, across every computer. Returns how many went.
   *
   * A page is a distinct row, so a Bot that browses grows this table for as long as it runs and
   * nothing ever took anything out of it. Screenshots are the largest thing this deployment stores
   * and the least useful once nobody is reading that conversation any more.
   */
  purge: (olderThanMs: number) => Promise<number>;
};

export function createPageFrameStore(database: Database): PageFrameStore {
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
      await database
        .insert(computerPageFrame)
        .values({
          computerId: input.computerId,
          toolCallId: input.toolCallId,
          url: input.url,
          ...(input.title ? { title: input.title } : {}),
          frame: input.frame,
        })
        /*
         * Written once. A turn happens once and is then over for good, so a second write for the
         * same turn is either a retry of the same thing or a mistake, and neither should change what
         * a past turn shows. Letting the newer win is what made the record mutable before.
         */
        .onConflictDoNothing();
    },

    async load(computerId, toolCallId) {
      const [row] = await database
        .select({
          url: computerPageFrame.url,
          title: computerPageFrame.title,
          frame: computerPageFrame.frame,
        })
        .from(computerPageFrame)
        /*
         * Both, always. A caller who may reach one Bot must not be able to read another Bot's screen
         * by naming a turn: the Bot in the path is what the route already checked, so it is what this
         * is keyed on too.
         */
        .where(
          and(
            eq(computerPageFrame.computerId, computerId),
            eq(computerPageFrame.toolCallId, toolCallId),
          ),
        );
      return row ?? null;
    },

    async clear(computerId) {
      const gone = await database
        .delete(computerPageFrame)
        .where(eq(computerPageFrame.computerId, computerId))
        .returning({ url: computerPageFrame.url });
      return gone.length;
    },

    async purge(olderThanMs) {
      const gone = await database
        .delete(computerPageFrame)
        .where(
          lt(
            computerPageFrame.capturedAt,
            sql`now() - make_interval(secs => ${olderThanMs / 1000})`,
          ),
        )
        .returning({ url: computerPageFrame.url });
      return gone.length;
    },
  };
}
