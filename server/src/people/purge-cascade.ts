/**
 * What Intelligence holds of a person beyond the organization directory, removed when OpenBot removes
 * them for good.
 *
 * A person's row in `users` used to take with it, by `ON DELETE CASCADE`: their memories and memory
 * sources, their Learning space, sharing choice and thread containers, and their routines, check-ins
 * and responsibilities with every run. Those live in Intelligence now, in capabilities that know
 * nothing of the directory, so this is that cascade, run by hand when the people directory says a
 * person was deleted for good (`PeopleDirectory.onPurged`). Their Bot configuration (preferences,
 * publications, owned skills) goes by its own sweep (`configuration/people-sweep.ts`).
 *
 * Every part runs whatever the others did, so one that fails leaves no other undone; the failures are
 * then thrown together, naming each part.
 */
import { removePersonLearning } from "../learning/personal-space";
import type { LearningIntelligence } from "../learning/intelligence";
import type { MemoryStore } from "../memory/store";

export function createPersonPurgeCascade(parts: {
  memory: Pick<MemoryStore, "forgetPerson">;
  learning: Pick<
    LearningIntelligence,
    "purgePersonalSpace" | "deleteThreadAssignments"
  >;
  schedules: { purgeOwner(ownerUserId: string): Promise<unknown> };
}): (userId: string) => Promise<void> {
  return async (userId) => {
    const failures: { part: string; error: unknown }[] = [];
    const steps: [string, () => Promise<unknown>][] = [
      ["memory", () => parts.memory.forgetPerson(userId)],
      ["Learning", () => removePersonLearning(parts.learning, userId)],
      ["schedules", () => parts.schedules.purgeOwner(userId)],
    ];
    for (const [part, run] of steps) {
      try {
        await run();
      } catch (error) {
        failures.push({ part, error });
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `Removing what Intelligence holds of ${userId} failed for ${failures
          .map(
            (failure) =>
              `${failure.part} (${failure.error instanceof Error ? failure.error.message : String(failure.error)})`,
          )
          .join(", ")}`,
      );
  };
}
