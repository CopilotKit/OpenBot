import { describe, expect, mock, test } from "bun:test";
import type { Sql } from "postgres";
import { runMigrations } from "../scripts/migrate";
import { MigrationsOutOfReachError } from "../src/db/apply-migrations";

/**
 * The migration runner releases its connection in a `finally`, and an awaited rejection there
 * REPLACES whatever was already in flight. The error the run exists to deliver — the refusal that
 * names the migrations a database walked past — must survive a release that fails.
 *
 * No database: a connection whose `end` rejects is the whole subject, and a real one does not
 * reject on demand.
 */

const REFUSAL =
  "refusing to migrate: 0057_example is stamped earlier than a migration this database has applied";

function connectionWhoseEndRejects(failure: Error) {
  const end = mock(async () => {
    throw failure;
  });
  return { client: { end } as unknown as Sql, end };
}

async function settle(run: Promise<void>): Promise<unknown> {
  return run.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

describe("runMigrations teardown", () => {
  test("a rejecting release does not replace the out-of-reach refusal", async () => {
    const { client, end } = connectionWhoseEndRejects(
      new Error("write CONNECTION_ENDED"),
    );
    const refuse = async () => {
      throw new MigrationsOutOfReachError(REFUSAL);
    };

    const outcome = await settle(runMigrations(client, "unused", refuse));

    expect(outcome).toBeInstanceOf(MigrationsOutOfReachError);
    expect((outcome as Error).message).toBe(REFUSAL);
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("a rejecting release after a clean run is still a failure", async () => {
    const teardown = new Error("write CONNECTION_ENDED");
    const { client, end } = connectionWhoseEndRejects(teardown);
    const migrate = async () => {};

    const outcome = await settle(runMigrations(client, "unused", migrate));

    expect(outcome).toBe(teardown);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
