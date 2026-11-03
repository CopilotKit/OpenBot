import type { LearningIntelligence } from "../learning/intelligence";

/** The capture pass and the selector run inside the runtime's 5 s deadline, so each call to Intelligence is short. */
const CALL_LIMITS = { timeoutMs: 3_000, attempts: 2 };
/** Trajectories this instance remembers as bound to their person. A binding never changes once made. */
const HELD = 10_000;

/**
 * Which person each Recorder trajectory belongs to. The first capture pass for a trajectory binds it to the person whose
 * browser asked; a later pass for it must come from the same person. Intelligence records it (the trajectory's app
 * user, the same one its join checks), so every replica agrees and the Runtime's join can never disagree with it.
 * Nothing recorded is kept here: the trajectory lives in Intelligence, in that person's own Learning space.
 */
export function createTrajectoryBindingStore(
  intelligence: Pick<
    LearningIntelligence,
    "claimTrajectory" | "trajectoryOwner"
  >,
) {
  /** `trajectoryId` -> the person it is bound to, for those this instance bound or read. */
  const owners = new Map<string, string>();
  const remember = (trajectoryId: string, userId: string) => {
    owners.delete(trajectoryId);
    owners.set(trajectoryId, userId);
    if (owners.size > HELD) {
      const oldest = owners.keys().next().value;
      if (oldest !== undefined) owners.delete(oldest);
    }
  };

  return {
    /**
     * Binds the trajectory to this person, or finds it already bound to them. False when it is bound to anyone else.
     * `trajectoryId` must already be a UUID.
     */
    async bind(input: {
      trajectoryId: string;
      userId: string;
    }): Promise<boolean> {
      const held = owners.get(input.trajectoryId);
      if (held !== undefined) return held === input.userId;
      if (
        !(await intelligence.claimTrajectory(
          input.trajectoryId,
          input.userId,
          CALL_LIMITS,
        ))
      )
        return false;
      remember(input.trajectoryId, input.userId);
      return true;
    },
    /** Whether this trajectory is bound to this person. */
    async isBoundTo(trajectoryId: string, userId: string): Promise<boolean> {
      const held = owners.get(trajectoryId);
      if (held !== undefined) return held === userId;
      const owner = await intelligence.trajectoryOwner(
        trajectoryId,
        CALL_LIMITS,
      );
      if (owner === null) return false;
      remember(trajectoryId, owner);
      return owner === userId;
    },
  };
}
export type TrajectoryBindingStore = ReturnType<
  typeof createTrajectoryBindingStore
>;
