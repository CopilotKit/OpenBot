import {
  DEFAULT_USER_PREFERENCES,
  isSkinId,
  type UserPreferences,
} from "@openbot/shared/user-preferences";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./db/client";
import { users } from "./db/schema";

/*
 * What is stored, over the defaults. A skin a later build no longer ships stays in the row, so going
 * back to a build that has it brings it back, but this build answers with its default.
 */
function withDefaults(stored: Partial<UserPreferences>): UserPreferences {
  const preferences = { ...DEFAULT_USER_PREFERENCES, ...stored };
  return isSkinId(preferences.skin)
    ? preferences
    : { ...preferences, skin: DEFAULT_USER_PREFERENCES.skin };
}

export type UserPreferencesStore = {
  claimStarterTour: (userId: string, channelId: string) => Promise<void>;
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
    async claimStarterTour(userId, channelId) {
      // PostgreSQL rechecks the condition after a concurrent row update. Only one
      // new conversation can win, even across server processes; merge keeps other preferences.
      await database
        .update(users)
        .set({
          preferences: sql`${users.preferences} || ${{ starterTourChannelId: channelId }}::jsonb`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(users.id, userId),
            sql`NOT (${users.preferences} ? 'starterTourChannelId')`,
          ),
        );
    },
    async read(userId) {
      const [user] = await database
        .select({ preferences: users.preferences })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user) throw new Error("User preferences could not be found.");
      return withDefaults(user.preferences);
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
      return withDefaults(user.preferences);
    },
  };
}
