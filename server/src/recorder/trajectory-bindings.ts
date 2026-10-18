import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { recorderTrajectoryBindings } from "../db/schema/recorder";

/**
 * Which person and Bot each Recorder trajectory belongs to. The first capture pass for a trajectory binds it; every
 * later pass must name the same person and Bot. Nothing recorded is kept: the trajectory lives in Intelligence.
 */
export function createTrajectoryBindingStore(database: Database) {
  return {
    /**
     * Binds the trajectory to this person and Bot, or finds it already bound to them. False when it is bound to
     * anyone or anything else. `trajectoryId` must already be a UUID (the column is one).
     */
    async bind(input: {
      trajectoryId: string;
      userId: string;
      botId: string;
    }): Promise<boolean> {
      const [inserted] = await database
        .insert(recorderTrajectoryBindings)
        .values(input)
        .onConflictDoNothing({
          target: recorderTrajectoryBindings.trajectoryId,
        })
        .returning({ trajectoryId: recorderTrajectoryBindings.trajectoryId });
      if (inserted) return true;
      const [bound] = await database
        .select({
          userId: recorderTrajectoryBindings.userId,
          botId: recorderTrajectoryBindings.botId,
        })
        .from(recorderTrajectoryBindings)
        .where(eq(recorderTrajectoryBindings.trajectoryId, input.trajectoryId))
        .limit(1);
      return bound?.userId === input.userId && bound.botId === input.botId;
    },

    /** The Bot this person's trajectory is bound to, or null when it is not theirs or not bound. */
    async botFor(trajectoryId: string, userId: string): Promise<string | null> {
      const [bound] = await database
        .select({ botId: recorderTrajectoryBindings.botId })
        .from(recorderTrajectoryBindings)
        .where(
          and(
            eq(recorderTrajectoryBindings.trajectoryId, trajectoryId),
            eq(recorderTrajectoryBindings.userId, userId),
          ),
        )
        .limit(1);
      return bound?.botId ?? null;
    },
  };
}
