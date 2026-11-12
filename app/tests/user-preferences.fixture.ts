import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
} from "@openbot/shared/user-preferences";

/**
 * A complete set of account preferences, with only the fields a test cares about changed.
 *
 * The server always answers with every field (`withDefaults` in `server/src/user-preferences.ts`),
 * so a preferences value put in the query cache has to be complete as well. Spelling it out in each
 * test is what let a newly added field go missing from a fixture and fail the typecheck instead of
 * the test; overriding the defaults keeps the fixtures honest without repeating them.
 */
export function makeUserPreferences(
  overrides: Partial<UserPreferences> = {},
): UserPreferences {
  return { ...DEFAULT_USER_PREFERENCES, ...overrides };
}