/**
 * What a Bot's screen looked like when one turn finished with it.
 *
 * Written once when a browsing turn ends and read back when somebody reopens the conversation. The
 * transcript used to fetch the live screen for every past turn, so an answer about one page sat under
 * a picture of whichever page the Bot had open by the time it was read back.
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { computerTurnFrame } from "../db/schema";

/**
 * A screenshot, and the ceiling on one.
 *
 * Generous enough for a full page at the sizes a computer runs, small enough that nothing can push
 * megabytes into the transcript by calling this in a loop. Refused at the boundary rather than
 * truncated, because half a PNG is not a smaller picture, it is a broken one.
 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type TurnFrameStore = {
  save: (frame: {
    toolCallId: string;
    computerId: string;
    url: string;
    title?: string;
    frame: string;
  }) => Promise<void>;
  load: (
    toolCallId: string,
    computerId: string,
  ) => Promise<{ url: string; title: string | null; frame: string } | null>;
};

export function createTurnFrameStore(database: Database): TurnFrameStore {
  return {
    async save(input) {
      if (input.frame.length > MAX_FRAME_BYTES) {
        throw new Error("That screenshot is too large to keep.");
      }
      await database
        .insert(computerTurnFrame)
        .values({
          toolCallId: input.toolCallId,
          computerId: input.computerId,
          url: input.url,
          ...(input.title ? { title: input.title } : {}),
          frame: input.frame,
        })
        /*
         * Nothing on conflict. A turn that has happened does not happen differently later, and the
         * first frame written for a tool call is the one that turn ended on. A retry or a second
         * render must not overwrite it with whatever is on screen by then.
         */
        .onConflictDoNothing();
    },

    async load(toolCallId, computerId) {
      const [row] = await database
        .select({
          url: computerTurnFrame.url,
          title: computerTurnFrame.title,
          frame: computerTurnFrame.frame,
        })
        .from(computerTurnFrame)
        /*
         * Both, always. The tool call id alone is unique, but a caller who may reach one Bot must not
         * be able to read a frame from another by guessing an id: the Bot in the path is what the
         * route already checked, so it is what this is keyed on too.
         */
        .where(
          and(
            eq(computerTurnFrame.toolCallId, toolCallId),
            eq(computerTurnFrame.computerId, computerId),
          ),
        );
      return row ?? null;
    },
  };
}
