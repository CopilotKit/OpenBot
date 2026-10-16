import postgres, { type Options } from "postgres";

/**
 * SSL for the small number of postgres.js clients (migrations, LISTEN/NOTIFY).
 *
 * The main API pool is `createDatabase` in `client.ts` (Bun SQL). Managed Postgres needs TLS there
 * too, so both clients derive it from `sslmode=require` on DATABASE_URL. DATABASE_SSL=require can
 * explicitly force TLS for both paths.
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
