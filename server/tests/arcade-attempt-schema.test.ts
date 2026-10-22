// server/tests/arcade-attempt-schema.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { mcpServers } from "../src/db/schema/plugins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const serverId = `arcade-attempt-${suite}`;

/*
 * The three actors the cases below claim under, seeded as real people because `actor_id` now carries
 * the key to `users` it always claimed in the docblock (and `user_id` is held equal to it). Named up here so
 * `afterAll` can delete them, and so the cascade takes the attempts with them.
 */
const actors = [`live-${suite}`, `expired-${suite}`, `done-${suite}`];

/** The one statement a start-attempt route issues: take the key if free, expired, or completed. */
const claim = (actorId: string, authId: string) =>
  database.execute(sql`
    INSERT INTO pending_authorizations
      (actor_id, server_id, action, holder, user_id, vendor_user_id, auth_id)
    VALUES (${actorId}, ${serverId}, 'connect', 'person', ${actorId}, ${`v-${actorId}`}, ${authId})
    ON CONFLICT (actor_id) DO UPDATE SET
      server_id = EXCLUDED.server_id,
      action = EXCLUDED.action,
      holder = EXCLUDED.holder,
      user_id = EXCLUDED.user_id,
      vendor_user_id = EXCLUDED.vendor_user_id,
      auth_id = EXCLUDED.auth_id,
      created_at = now(),
      completed_at = NULL,
      outcome = NULL
    WHERE pending_authorizations.created_at < now() - interval '15 minutes'
      OR pending_authorizations.completed_at IS NOT NULL
    RETURNING *
  `);

beforeAll(async () => {
  await seedPeople(database, actors);
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Attempt schema",
    vendor: "test",
    url: "https://example.invalid/mcp",
  });
});

afterAll(async () => {
  await database.execute(sql`delete from mcp_servers where id = ${serverId}`);
  await removePeople(database, actors);
  await database.$client.close();
});

describe("pending_authorizations", () => {
  test("a second attempt for one actor is refused while the first is live", async () => {
    const actor = actors[0]!;
    expect((await claim(actor, "auth-1")).length).toBe(1);
    expect((await claim(actor, "auth-2")).length).toBe(0);
    const rows = await database.execute(
      sql`select auth_id from pending_authorizations where actor_id = ${actor}`,
    );
    expect(rows[0]?.auth_id).toBe("auth-1");
  });

  test("an expired attempt is replaceable in one statement", async () => {
    const actor = actors[1]!;
    expect((await claim(actor, "auth-old")).length).toBe(1);
    await database.execute(
      sql`update pending_authorizations set created_at = now() - interval '16 minutes' where actor_id = ${actor}`,
    );
    const replaced = await claim(actor, "auth-new");
    expect(replaced.length).toBe(1);
    expect(replaced[0]?.auth_id).toBe("auth-new");
  });

  test("a completed attempt is replaceable", async () => {
    const actor = actors[2]!;
    expect((await claim(actor, "auth-old")).length).toBe(1);
    await database.execute(
      sql`update pending_authorizations set completed_at = now(), outcome = 'completed' where actor_id = ${actor}`,
    );
    const replaced = await claim(actor, "auth-new");
    expect(replaced.length).toBe(1);
    expect(replaced[0]?.auth_id).toBe("auth-new");
    expect(replaced[0]?.completed_at).toBeNull();
    expect(replaced[0]?.outcome).toBeNull();
  });
});
