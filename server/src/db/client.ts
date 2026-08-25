import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

/**
 * `max` is exposed so tests can pin the pool to a single connection. Code that opens a transaction
 * and then reads on a second connection deadlocks once every pooled connection is inside such a
 * transaction; a pool of one turns that from a load-dependent production hang into an immediate,
 * reproducible failure.
 */
export function createDatabase(
  databaseUrl: string,
  options: { max?: number } = {},
) {
  /*
   * Loud rather than silent when the arguments are the wrong way round.
   *
   * Bun's `SQL` takes either a URL or an options object as its one argument, so a caller passing the
   * pool options where the address belongs gets a working database from `$DATABASE_URL` and no
   * complaint. Two tests were doing exactly that, green for a reason that had nothing to do with
   * what they were checking, and the test tree is not type-checked so nothing else was going to say
   * so. A connection string is a string.
   */
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new TypeError(
      "createDatabase needs a connection string as its first argument. Pool options go second.",
    );
  }
  const client =
    options.max === undefined
      ? new SQL(databaseUrl)
      : new SQL(databaseUrl, { max: options.max });

  return drizzle({ client, schema });
}

export type Database = ReturnType<typeof createDatabase>;
