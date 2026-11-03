import {
  DEFAULT_USER_PREFERENCES,
  isSkinId,
  type UserPreferences,
} from "@openbot/shared/user-preferences";
import { eq } from "drizzle-orm";
import type { Database } from "./db/client";
import { users } from "./db/schema";
import { PersonMissingError } from "./people/directory/client";
import { people } from "./people/directory/directory";

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
      return withDefaults(user.preferences);
    },
    async patch(userId, preferences) {
      let person: Awaited<ReturnType<ReturnType<typeof people>["update"]>>;
      try {
        // Merged over what Intelligence's directory holds, under its version: a save made meanwhile
        // to a different preference makes this one read again and merge again, so both survive.
        person = await people().update(userId, (current) => ({
          preferences: { ...current.preferences, ...preferences },
        }));
      } catch (error) {
        if (error instanceof PersonMissingError)
          throw new Error("User preferences could not be saved.");
        throw error;
      }
      return withDefaults(person.preferences);
    },
  };
}
