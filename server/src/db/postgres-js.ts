import postgres, { type Options } from "postgres";

/**
 * SSL for the small number of postgres.js clients (migrations, LISTEN/NOTIFY).
 *
 * The main API pool is `createDatabase` in `client.ts` (Bun SQL). It already forwards URL query
 * parameters such as `sslmode=require` into the connection. Managed Postgres (RDS, etc.) expects
 * that on `DATABASE_URL` rather than a separate code change.
 */
function sslFromDatabaseUrl(databaseUrl: string): Options<Record<string, never>>["ssl"] {
  if (process.env.DATABASE_SSL?.trim() === "require") {
    return "require";
  }
  try {
    const mode = new URL(databaseUrl).searchParams.get("sslmode")?.trim();
    if (mode === "require" || mode === "verify-full" || mode === "verify-ca") {
      return "require";
    }
  } catch {
    // Invalid URL; postgres() will fail with its own error.
  }
  return undefined;
}

export function createPostgresJsClient(
  databaseUrl: string,
  options: Options<Record<string, never>> = {},
): ReturnType<typeof postgres> {
  const ssl = options.ssl ?? sslFromDatabaseUrl(databaseUrl);
  return postgres(databaseUrl, {
    ...options,
    ...(ssl === undefined ? {} : { ssl }),
  });
}
