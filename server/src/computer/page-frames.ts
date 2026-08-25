/**
 * What a Bot's screen looked like when it opened a page.
 *
 * Written where the navigation happens, which is the one moment the screen is certainly showing the
 * page that was asked for, and read back when somebody reopens the conversation that asked for it.
 */
import { and, eq } from "drizzle-orm";
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

export type PageFrameStore = {
  save: (frame: {
    computerId: string;
    url: string;
    title?: string;
    frame: string;
  }) => Promise<void>;
  load: (
    computerId: string,
    url: string,
  ) => Promise<{ url: string; title: string | null; frame: string } | null>;
};

export function createPageFrameStore(database: Database): PageFrameStore {
  return {
    async save(input) {
      if (!input.url || input.frame.length > MAX_FRAME_BYTES) return;
      await database
        .insert(computerPageFrame)
        .values({
          computerId: input.computerId,
          url: input.url,
          ...(input.title ? { title: input.title } : {}),
          frame: input.frame,
        })
        /*
         * Newest wins. A page visited twice is the same address showing something different, and the
         * more recent visit is the one a reader is most likely asking about. An older frame of the
         * same page is not more true, only older.
         */
        .onConflictDoUpdate({
          target: [computerPageFrame.computerId, computerPageFrame.url],
          set: {
            frame: input.frame,
            ...(input.title ? { title: input.title } : {}),
            capturedAt: new Date(),
          },
        });
    },

    async load(computerId, url) {
      const [row] = await database
        .select({
          url: computerPageFrame.url,
          title: computerPageFrame.title,
          frame: computerPageFrame.frame,
        })
        .from(computerPageFrame)
        /*
         * Both, always. A caller who may reach one Bot must not be able to read another Bot's screen
         * by naming a page: the Bot in the path is what the route already checked, so it is what this
         * is keyed on too.
         */
        .where(
          and(
            eq(computerPageFrame.computerId, computerId),
            eq(computerPageFrame.url, url),
          ),
        );
      return row ?? null;
    },
  };
}
