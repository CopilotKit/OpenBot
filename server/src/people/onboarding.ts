import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import { people } from "./directory/directory";

/**
 * Where one person is in first-run onboarding.
 *
 * A null `completedAt` is what gates the app into /onboarding. `step` is stored and served but
 * NOTHING RESUMES FROM IT YET: the wizard keeps its step in browser state while its content is
 * still being designed, so this stays 0 through a whole run. It exists so resuming is a frontend
 * change when the wizard settles, not a migration.
 */
export type OnboardingStatus = {
  step: number;
  completedAt: string | null;
};

export type OnboardingStore = {
  status: (userId: string) => Promise<OnboardingStatus>;
  setStep: (userId: string, step: number) => Promise<void>;
  complete: (userId: string) => Promise<void>;
};

export function createOnboardingStore(database: Database): OnboardingStore {
  return {
    async status(userId) {
      const [row] = await database
        .select({
          step: users.onboardingStep,
          completedAt: users.onboardingCompletedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      /*
       * No row reads as not started rather than as an error. It should not happen — a session
       * cannot outlive its users row (the foreign key cascades) and the single-user actor's row is
       * seeded at startup — but a guard that throws here would take /api/me down with it.
       */
      return {
        step: row?.step ?? 0,
        completedAt: row?.completedAt ? row.completedAt.toISOString() : null,
      };
    },

    // Written to the person in Intelligence's directory, and from there to their row here.
    async setStep(userId, step) {
      await people().update(userId, (current) =>
        current.onboardingStep === step ? null : { onboardingStep: step },
      );
    },

    async complete(userId) {
      await people().update(userId, (current) =>
        // Idempotent: finishing again keeps the first timestamp, so "when did they onboard"
        // stays one answer.
        current.onboardingCompletedAt
          ? null
          : { onboardingCompletedAt: new Date() },
      );
    },
  };
}
