import { customType } from "drizzle-orm/pg-core";

/**
 * A `jsonb` column that actually stores JSON.
 *
 * Drizzle's ordinary `jsonb()` serialises the value in `mapToDriverValue`, and Bun's `SQL` driver
 * serialises it again on the way to Postgres. Objects that need SQL JSON operators use this custom
 * type so they are stored as JSON objects. The same insert through both paths:
 *
 *   drizzle jsonb()   jsonb_typeof = "string"   payload->>'bot' = NULL
 *   this type         jsonb_typeof = "object"   payload->>'bot' = "y"
 *
 * Application reads can still render double-encoded values as objects. SQL consumers require stored
 * JSON objects so fields such as `payload->>'bot'` stay queryable.
 *
 * Serialize once. The driver already knows how to send an object to a `jsonb`
 * parameter, so this hands it the object and stays out of the way. Reads are unchanged: both paths
 * return an object, which is why this can be swapped in without touching a single call site.
 *
 * Use this everywhere instead of `jsonb` from `drizzle-orm/pg-core`.
 */
export const jsonb = customType<{
  data: Record<string, unknown>;
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  // Straight through. The double `JSON.stringify` is the whole bug.
  toDriver: (value) => value,
});
