import { eq, sql } from "drizzle-orm";
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "../../shared/user-preferences";
import type { Database } from "./db/client";
import { users } from "./db/schema";

export type UserPreferencesStore = {
  read: (userId: string) => Promise<UserPreferences>;
  patch: (
    userId: string,
    preferences: Partial<UserPreferences>,
  ) => Promise<UserPreferences>;
};

export function createUserPreferencesStore(
  database: Database,
): UserPreferencesStore {
  return {
    async read(userId) {
      const [user] = await database
        .select({ preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new Error("User preferences could not be found.");
      return { ...DEFAULT_USER_PREFERENCES, ...user.preferences };
    },
    async patch(userId, preferences) {
      const [user] = await database
        .update(users)
        .set({
          // Merge in Postgres so simultaneous updates to different preferences are preserved.
          preferences: sql`${users.preferences} || ${preferences}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning({ preferences: users.preferences });
      if (!user) throw new Error("User preferences could not be saved.");
      return { ...DEFAULT_USER_PREFERENCES, ...user.preferences };
    },
  };
}
