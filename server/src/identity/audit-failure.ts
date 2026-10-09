type Driver = { name?: unknown; errno?: unknown; code?: unknown };

function sqlState(error: unknown): string | undefined {
  // Bun's driver throws a `PostgresError` with the SQLSTATE in `errno`; node-style drivers use
  // `code`. Drizzle wraps the driver error as `cause`. Only a Postgres error is trusted: system
  // errno names such as EPIPE or EPERM are also five characters and must not pass as a SQLSTATE.
  for (const candidate of [
    error,
    (error as { cause?: unknown } | null | undefined)?.cause,
  ]) {
    const driver = candidate as Driver | null | undefined;
    if (driver?.name !== "PostgresError") continue;
    for (const value of [driver.errno, driver.code])
      if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value))
        return value;
  }
  return undefined;
}

/**
 * Logs that the `identity.linked` audit write failed after the link committed. A database error's
 * message carries the failed query's parameters (user id, link id, payload), so only the error's
 * name and its Postgres SQLSTATE are logged: never the message, query, ids or subjects.
 */
export function logLinkAuditFailure(provider: string, error: unknown): void {
  const code = sqlState(error);
  console.error(
    JSON.stringify({
      type: "identity-link-audit-failed",
      provider,
      errorName: error instanceof Error ? error.name : "unknown",
      ...(code ? { errorCode: code } : {}),
    }),
  );
}
