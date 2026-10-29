import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { recorderTrajectoryBindings } from "../db/schema/recorder";

/**
 * Which person each Recorder trajectory belongs to. The first capture pass for a trajectory binds it to the person whose
 * browser asked; a later pass for it must come from the same person. Nothing recorded is kept: the trajectory lives in
 * Intelligence, in that person's own Learning space.
 */
export function createTrajectoryBindingStore(database: Database) {
  /** Whether this trajectory is bound to this person. */
  const isBoundTo = async (
    trajectoryId: string,
    userId: string,
  ): Promise<boolean> => {
    const [bound] = await database
      .select({ userId: recorderTrajectoryBindings.userId })
      .from(recorderTrajectoryBindings)
      .where(
        and(
          eq(recorderTrajectoryBindings.trajectoryId, trajectoryId),
          eq(recorderTrajectoryBindings.userId, userId),
        ),
      )
      .limit(1);
    return bound !== undefined;
  };

  return {
    /**
     * Binds the trajectory to this person, or finds it already bound to them. False when it is bound to anyone else.
     * `trajectoryId` must already be a UUID (the column is one).
     */
    async bind(input: {
      trajectoryId: string;
      userId: string;
    }): Promise<boolean> {
      const [inserted] = await database
        .insert(recorderTrajectoryBindings)
        .values(input)
        .onConflictDoNothing({
          target: recorderTrajectoryBindings.trajectoryId,
        })
        .returning({ trajectoryId: recorderTrajectoryBindings.trajectoryId });
      if (inserted) return true;
      return isBoundTo(input.trajectoryId, input.userId);
    },
    isBoundTo,
  };
}
