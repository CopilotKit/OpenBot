// server/tests/arcade-attempt-constraints.test.ts
//
// `pending_authorizations` declares two unions in TypeScript — `holder` and `outcome` — and
// drizzle's `$type<>` is erased at runtime, so only the database can hold them. These are the
// checks the sibling table `brokered_connections` has had all along, asked of the new table:
// a holder outside the pair, an outcome outside the roster, and the two holder/`user_id`
// combinations `brokered_connections_holder_check` exists to make impossible.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { mcpServers, pendingAuthorizations } from "../src/db/schema/plugins";
import { checkRoster } from "./support/constraints";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const serverId = `arcade-constraints-${suite}`;

/**
 * An attempt row with every column legal, so each test varies exactly the one it is about.
 *
 * `userId` defaults to the actor, because a `person` attempt is for the actor's own account and the
 * database holds that (`pending_authorizations_user_is_actor_check`). This fixture used to give
 * every row one shared `user-${suite}` beside a fresh actor — a two-person row production never
 * writes, and exactly the shape that let one person's deletion take another person's attempt.
 */
const attempt = (overrides: Record<string, unknown>) => {
  const actorId =
    (overrides.actorId as string | undefined) ??
    `actor-${randomUUID().slice(0, 8)}`;
  return {
    actorId,
    serverId,
    action: "connect",
    holder: "person" as const,
    userId: actorId,
    vendorUserId: `v-${suite}`,
    ...overrides,
  };
};

/**
 * Every person this file invented, so `afterAll` can take them away again.
 *
 * `actor_id` keys to `users` and cascades (and `user_id`, when set, must equal it), so the row a
 * case is about cannot be written until its person exists — and deleting the person afterwards is
 * also what deletes the attempt. Seeding happens inside {@link insert} rather than in `beforeAll` because the actor id is
 * generated per row, and a case that forgot to seed its own would otherwise be refused by the
 * foreign key and read as a CHECK that did not fire.
 */
const seeded = new Set<string>();

const seedFor = async (row: Record<string, unknown>) => {
  const people = [row.actorId, row.userId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  for (const id of people) seeded.add(id);
  await seedPeople(database, people);
};

// Awaited rather than handed back as a builder, so a failure says what the database did with the
// row and not what drizzle's query object looks like.
const insert = async (overrides: Record<string, unknown>) => {
  const row = attempt(overrides);
  await seedFor(row);
  await database
    .insert(pendingAuthorizations)
    // biome-ignore lint/suspicious/noExplicitAny: the point is what the DATABASE refuses, past the declared unions.
    .values(row as any);
};

/**
 * The name of the constraint that refused a statement, or `"accepted"` if nothing did.
 *
 * Named rather than merely thrown, because "it threw" would also pass on a typo in a column name.
 * drizzle's own message is only "Failed query: ..."; the constraint it tripped is `constraint` on
 * the postgres error underneath.
 */
const refusedBy = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? String(error);
  }
  return "accepted";
};

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Attempt constraints",
    vendor: "test",
    url: "https://example.invalid/mcp",
  });
});

afterAll(async () => {
  await database.execute(sql`delete from mcp_servers where id = ${serverId}`);
  await removePeople(database, [...seeded]);
  await database.$client.close();
});

describe("pending_authorizations holds its declared unions", () => {
  test("a holder outside the pair is refused", async () => {
    expect(await refusedBy(() => insert({ holder: "llama" }))).toBe(
      "pending_authorizations_holder_check",
    );
  });

  /*
   * Each roster case carries a `completed_at` alongside its junk `outcome`, so the row is legal in
   * every respect but the one under test. Without it the row also breaks the completion pairing
   * below, postgres names whichever constraint it evaluated first, and the test stops being about
   * the roster at all.
   */
  test("an outcome outside the roster is refused on insert", async () => {
    expect(
      await refusedBy(() =>
        insert({ outcome: "banana", completedAt: new Date() }),
      ),
    ).toBe("pending_authorizations_outcome_check");
  });

  test("an outcome outside the roster is refused on update", async () => {
    const actorId = `update-${suite}`;
    await insert({ actorId });
    const refusal = await refusedBy(() =>
      database
        .update(pendingAuthorizations)
        // biome-ignore lint/suspicious/noExplicitAny: a cast past the union is exactly what the CHECK is for.
        .set({ outcome: "cancelled" as any, completedAt: new Date() })
        .where(sql`actor_id = ${actorId}`),
    );
    expect(refusal).toBe("pending_authorizations_outcome_check");
  });

  /**
   * The pairing of `completed_at` and `outcome`, which is the one invariant of this table that no
   * single column can hold.
   *
   * A row carrying an `outcome` with `completed_at` still NULL is a FINISHED attempt that every
   * reader here reads as a LIVE one: `claimAuthorizationAttempt` replaces a held key only
   * `WHERE created_at < now() - interval '15 minutes' OR completed_at IS NOT NULL`, and
   * `authorizationAttemptFor` answers on `completed_at IS NULL` alone. Neither looks at `outcome`,
   * so such a row locks its actor out of starting another authorization for the rest of the TTL,
   * with a verdict already recorded against it. The other half is less damaging and just as wrong:
   * a `completed_at` with no `outcome` is an attempt that ended with nothing saying how, and every
   * operator-facing reading of the table is of `outcome`.
   *
   * Nothing in the application writes either shape — both writers set the pair in one statement —
   * which is exactly why it belongs in the database rather than in a comment: the only ways in are
   * a hand-run UPDATE, a restore, or the next writer, and none of those is reviewed here.
   */
  test("an outcome with no completion time is refused", async () => {
    expect(
      await refusedBy(() => insert({ outcome: "failed", completedAt: null })),
    ).toBe("pending_authorizations_completion_check");
  });

  test("a completion time with no outcome is refused", async () => {
    expect(
      await refusedBy(() => insert({ completedAt: new Date(), outcome: null })),
    ).toBe("pending_authorizations_completion_check");
  });

  test("breaking the pair by UPDATE is refused too", async () => {
    const actorId = `pair-${suite}`;
    await insert({ actorId });
    const refusal = await refusedBy(() =>
      database
        .update(pendingAuthorizations)
        .set({ outcome: "withdrawn" })
        .where(sql`actor_id = ${actorId}`),
    );
    expect(refusal).toBe("pending_authorizations_completion_check");
  });

  test("a person attempt with no user id is refused", async () => {
    expect(
      await refusedBy(() => insert({ holder: "person", userId: null })),
    ).toBe("pending_authorizations_holder_check");
  });

  test("a deployment attempt carrying a user id is refused", async () => {
    expect(
      await refusedBy(() =>
        // The actor's own id, so the user-is-actor CHECK is satisfied and only the holder pair can
        // be what refuses.
        insert({ holder: "deployment" }),
      ),
    ).toBe("pending_authorizations_holder_check");
  });

  /**
   * The rosters themselves, because every test above asks only about one value outside them.
   *
   * `llama` and `banana` go on being refused by a constraint that has quietly grown a member, and
   * `cancelled` goes on being refused right up until the day it is the member that was added — at
   * which point that test fails for the right reason and these two say which roster moved. The
   * TypeScript unions in `schema/plugins` are erased at runtime, so these lines and the migration
   * are the only two places the rosters exist; they have to be read against each other.
   */
  test("the holder CHECK admits exactly the two holders", async () => {
    expect(
      await checkRoster(database, "pending_authorizations_holder_check"),
    ).toEqual(["deployment", "person"]);
  });

  test("the outcome CHECK admits exactly the four outcomes", async () => {
    expect(
      await checkRoster(database, "pending_authorizations_outcome_check"),
    ).toEqual(["completed", "failed", "unreconciled", "withdrawn"]);
  });

  test("the legal shapes are all still accepted", async () => {
    const action = `legal-${suite}`;
    await insert({ action, holder: "person" });
    await insert({ action, holder: "deployment", userId: null });
    // Each ended shape carries its `completed_at`, because the pair is now held by a CHECK: an
    // outcome on its own is no longer one of the legal shapes, and this list says which are.
    for (const outcome of [
      null,
      "completed",
      "failed",
      "unreconciled",
      "withdrawn",
    ]) {
      await insert({
        action,
        outcome,
        completedAt: outcome === null ? null : new Date(),
      });
    }
    const rows = await database.execute(
      sql`select count(*)::int as n from pending_authorizations where action = ${action}`,
    );
    expect(rows[0]?.n).toBe(7);
  });
});

/**
 * The two columns that name `users.id`, and whether the database holds them to it.
 *
 * `0057` created both `actor_id` and `user_id` naming `users.id` in the docblock and carrying no
 * key, which is the shape where the schema is documentation and the data is whatever got written:
 * a deleted person left attempts pointing at nobody, and an actor id that was never a person at all
 * was accepted without complaint. `0059` adds both keys, cascading, and these are the cases that
 * say so — asked of the DATABASE, because a `.references()` in drizzle that no migration carried
 * into postgres enforces nothing at all.
 */
describe("pending_authorizations keys the people it names", () => {
  test("an actor who is not a person is refused", async () => {
    const stranger = `ghost-actor-${randomUUID().slice(0, 8)}`;
    const refusal = await refusedBy(() =>
      database
        .insert(pendingAuthorizations)
        // biome-ignore lint/suspicious/noExplicitAny: an id past the key is exactly what the FK is for.
        .values(attempt({ actorId: stranger, userId: stranger }) as any),
    );
    expect(refusal).toBe("pending_authorizations_actor_id_users_id_fk");
  });

  test("a user_id that is not a person is refused", async () => {
    // The actor IS a person here, so only the second column can be what refuses: a case that left
    // both unseeded would pass on the actor key alone and say nothing about `user_id`. What refuses
    // it is the user-is-actor CHECK, not a key of its own: `user_id` names a person
    // exactly when it names the actor, who is one.
    const actorId = `keyed-actor-${randomUUID().slice(0, 8)}`;
    await seedPeople(database, [actorId]);
    seeded.add(actorId);
    const refusal = await refusedBy(() =>
      database.insert(pendingAuthorizations).values(
        attempt({
          actorId,
          userId: `ghost-owner-${randomUUID().slice(0, 8)}`,
          // biome-ignore lint/suspicious/noExplicitAny: an id that names nobody is exactly what is being asked about.
        }) as any,
      ),
    );
    expect(refusal).toBe("pending_authorizations_user_is_actor_check");
  });

  test("deleting the person takes their in-flight attempt with them", async () => {
    const actorId = `departing-${randomUUID().slice(0, 8)}`;
    await insert({ actorId, userId: actorId });
    const before = await database.execute(
      sql`select count(*)::int as n from pending_authorizations where actor_id = ${actorId}`,
    );
    expect(before[0]?.n).toBe(1);

    await database.execute(sql`delete from users where id = ${actorId}`);
    seeded.delete(actorId);

    const after = await database.execute(
      sql`select count(*)::int as n from pending_authorizations where actor_id = ${actorId}`,
    );
    expect(after[0]?.n).toBe(0);
  });

  /**
   * The index, not merely the key.
   *
   * Postgres indexes the REFERENCED side of a foreign key and not the referencing side, so the
   * `server_id` key `0057` added left every cascade from `mcp_servers` — and every lookup by server
   * — scanning this table. There is nothing about a missing index a functional test can observe, so
   * it is asked for by name.
   *
   * The keys are read from `pg_constraint` rather than listed, so a key added later is held to the
   * same rule without anybody remembering this test — and the list is pinned too, so dropping or
   * adding one is a visible edit. `user_id` has no key (and no index) of its own; see the
   * user-is-actor cases below.
   */
  test("every foreign key on the table has an index leading with its column", async () => {
    const keys = await database.execute(sql`
      SELECT a.attname AS column
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'pending_authorizations'::regclass AND c.contype = 'f'
      ORDER BY a.attname
    `);
    const columns = keys.map((row) => String(row.column));
    const rows = await database.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'pending_authorizations'
    `);
    const definitions = rows.map((row) => String(row.indexdef));
    const led = (column: string) =>
      definitions.some((definition) =>
        definition.includes(`USING btree (${column}`),
      );
    expect(
      Object.fromEntries(columns.map((column) => [column, led(column)])),
    ).toEqual({ actor_id: true, server_id: true });
  });
});

/**
 * Whose deletion may take an attempt away: the person who STARTED it, and nobody else.
 *
 * The row is keyed by `actor_id` — one attempt per actor, by primary key — so it is the actor's.
 * `user_id` is whose account the attempt is for, and for a `person` attempt that is always the
 * actor too: `accountRefFor` answers a Personal app with `{ userId: actorId }`, and the only writer
 * (`claimAuthorizationAttempt`) copies that ref. In an earlier draft of this table nothing in the DATABASE said so, and
 * `user_id` carried a cascading key of its own — so a row naming two people died with EITHER of
 * them, and one person's deletion destroyed an attempt somebody else had started.
 *
 * The first case is the observation itself, asked without a branch: try to write the two-person
 * row, then — whatever the database did with it — give the actor their own attempt if the slot is
 * still free (`ON CONFLICT DO NOTHING`), delete the OTHER person, and count what the actor has
 * left. Against a schema that admits the two-person row, the actor's attempt is gone.
 */
describe("an attempt belongs to the person who started it", () => {
  test("deleting one person never takes an attempt a different person started", async () => {
    const actorId = `starter-${randomUUID().slice(0, 8)}`;
    const otherId = `other-${randomUUID().slice(0, 8)}`;
    await seedPeople(database, [actorId, otherId]);
    seeded.add(actorId);
    seeded.add(otherId);

    await refusedBy(() =>
      database
        .insert(pendingAuthorizations)
        // biome-ignore lint/suspicious/noExplicitAny: the two-person row is exactly what is being asked about.
        .values(attempt({ actorId, userId: otherId }) as any),
    );
    await database
      .insert(pendingAuthorizations)
      // biome-ignore lint/suspicious/noExplicitAny: a legal attempt, written past the declared unions like every row here.
      .values(attempt({ actorId, userId: actorId }) as any)
      .onConflictDoNothing();

    await database.execute(sql`delete from users where id = ${otherId}`);
    seeded.delete(otherId);

    const left = await database.execute(
      sql`select count(*)::int as n from pending_authorizations where actor_id = ${actorId}`,
    );
    expect(left[0]?.n).toBe(1);
  });

  test("a person attempt for somebody other than its actor is refused", async () => {
    const actorId = `starter-${randomUUID().slice(0, 8)}`;
    const otherId = `other-${randomUUID().slice(0, 8)}`;
    await seedPeople(database, [actorId, otherId]);
    seeded.add(actorId);
    seeded.add(otherId);
    expect(
      await refusedBy(() =>
        database
          .insert(pendingAuthorizations)
          // biome-ignore lint/suspicious/noExplicitAny: the two-person row is exactly what is being asked about.
          .values(attempt({ actorId, userId: otherId }) as any),
      ),
    ).toBe("pending_authorizations_user_is_actor_check");
  });
});
