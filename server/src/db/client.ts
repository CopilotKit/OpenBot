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
  const client =
    options.max === undefined
      ? new SQL(databaseUrl)
      : new SQL(databaseUrl, { max: options.max });

  return drizzle({ client, schema });
}

export type Database = ReturnType<typeof createDatabase>;
