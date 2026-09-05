import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

/**
 * `max` is exposed so tests can pin the pool to a single connection. Code that opens a transaction
 * and then reads on a second connection deadlocks once every pooled connection is inside such a
 * transaction; a pool of one turns that from a load-dependent production hang into an immediate,
 * reproducible failure.
 */
/**
 * The address, taken apart, because Bun will not take it whole on every platform.
 *
 * `new SQL("postgres://user:pass@host:5432/openbot")` works on macOS and Linux and cannot work on
 * Windows: Bun reads the URL's path, `/openbot`, as the path of a unix socket, ignores the host and
 * the port, and fails to open a socket that Windows does not have (oven-sh/bun#27713). The server
 * then cannot reach Postgres at all there, while `psql` inside the container and a plain TCP
 * connection from the same machine both succeed, which is what makes it look like a network fault
 * and not a parsing one.
 *
 * Passing the parts leaves nothing to parse. The behaviour is identical where the URL already
 * worked, since these are the same values Bun would have derived.
 */
function addressOf(databaseUrl: string) {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new TypeError(
      `DATABASE_URL is not a URL: ${JSON.stringify(databaseUrl)}`,
    );
  }
  if (url.hostname === "") {
    throw new TypeError(
      "DATABASE_URL names no host. Expected postgres://user:password@host:port/database.",
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database === "") {
    throw new TypeError(
      "DATABASE_URL names no database. Expected postgres://user:password@host:port/database.",
    );
  }
  return {
    adapter: "postgres" as const,
    hostname: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

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
  /*
   * `$DATABASE_URL` is taken out of the environment first, and stays out.
   *
   * Passing the parts is not enough on its own: Bun reads `$DATABASE_URL` when one is set and
   * prefers it to what the caller passed, so the address goes back through the parser this exists
   * to avoid and Windows fails exactly as before. Observed, not assumed: the options form connects
   * from a Bun script with no `$DATABASE_URL` set and fails inside the server, which is started
   * with `--env-file`, until the variable is gone.
   *
   * Nothing else reads it after this point. `loadConfig` has already captured it, and the worker
   * reads it into a local before it opens a database. Removing it also means a later
   * `new SQL()` cannot silently connect somewhere nobody named.
   */
  delete process.env.DATABASE_URL;

  const client = new SQL({
    ...addressOf(databaseUrl),
    ...(options.max === undefined ? {} : { max: options.max }),
  });

  return drizzle({ client, schema });
}

export type Database = ReturnType<typeof createDatabase>;
