import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agents } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * A jsonb column must hold JSON, not a string that looks like it.
 *
 * Drizzle's `jsonb()` serialises the value and Bun's SQL driver serialises it again, so this codebase
 * uses a custom type for objects that must stay queryable with JSON operators. The audit trail depends
 * on `payload->>'bot'` and related SQL reads returning fields from an object, not from a JSON string.
 *
 * These assertions are deliberately made in SQL, against a real database, on the shape of the stored
 * value rather than on what comes back through the application.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suite = randomUUID().slice(0, 8);
const agentId = `agent_jsonb_${suite}`;

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, agentId));
});

describe("what a jsonb column actually stores", () => {
  test("an object written through the schema is stored as an object", async () => {
    await database.insert(agents).values({
      id: agentId,
      name: agentId,
      type: "remote_ag_ui",
      configuration: {
        endpoint: "https://example.test/ag-ui",
        nested: { a: 1 },
      },
    });

    const [row] = await database.execute<{ shape: string; endpoint: string }>(
      sql`select jsonb_typeof(configuration) as shape,
                 configuration->>'endpoint' as endpoint
          from agents where id = ${agentId}`,
    );

    expect(row?.shape).toBe("object");
    // The SQL-queryability property: a key is reachable through JSON operators.
    expect(row?.endpoint).toBe("https://example.test/ag-ui");
  });

  test("an audit payload is queryable by its own fields", async () => {
    const store = createAuditStore(database);
    const marker = `bot_${suite}`;
    await recordAuditEvent(store, {
      eventType: "component.function_called",
      targetType: "component",
      targetId: `test_${suite}`,
      payload: { bot: marker, function: "botActivity" },
    });

    const [row] = await database.execute<{ shape: string; bot: string }>(
      sql`select jsonb_typeof(payload) as shape, payload->>'bot' as bot
          from audit_events where target_id = ${`test_${suite}`}`,
    );

    expect(row?.shape).toBe("object");
    expect(row?.bot).toBe(marker);
    // Left in place: the trail is append-only, so a test cannot tidy up after itself. One row.
  });

  test("the whole trail is objects, not strings", async () => {
    // A deployment that has run the migration has no string-shaped payloads left. Written as a sweep
    // rather than a single row because the failure this guards against is partial by nature: a new
    // column added with drizzle's `jsonb` would pass every test above and fail only here.
    const [row] = await database.execute<{ strings: number }>(
      sql`select count(*)::int as strings from audit_events
          where jsonb_typeof(payload) <> 'object'`,
    );
    expect(row?.strings).toBe(0);
  });
});
