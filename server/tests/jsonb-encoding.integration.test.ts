import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createAuditStore, recordAuditEvent } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { channels } from "../src/db/schema";
import { auditRows, useTestAuditTrail } from "./support/audit";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A jsonb column must hold JSON, not a string that looks like it.
 *
 * Drizzle's `jsonb()` serialises the value and Bun's SQL driver serialises it again, so this codebase
 * uses a custom type for objects that must stay queryable with JSON operators. The audit trail depends
 * on `payload->>'bot'` and related SQL reads returning fields from an object, not from a JSON string.
 *
 * These assertions are deliberately made in SQL, against a real database, on the shape of the stored
 * value rather than on what comes back through the application. The audit row is held twice: in the
 * local outbox it is written to (`audit_outbox.record`, payload at `record->'payload'`), and as
 * Intelligence hands it back once the outbox is carried there.
 */

useTestAuditTrail();

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const channelId = `channel_jsonb_${suite}`;

afterAll(async () => {
  await database.delete(channels).where(eq(channels.id, channelId));
});

describe("what a jsonb column actually stores", () => {
  test("an object written through the schema is stored as an object", async () => {
    // Every jsonb column goes through the same type, so any table's will do. This one wrote a Bot's
    // configuration until Bots moved to Intelligence; a channel's override holds the same shape.
    await database.insert(channels).values({
      id: channelId,
      name: channelId,
      description: "A jsonb test.",
      override: {
        endpoint: "https://example.test/ag-ui",
        nested: { a: 1 },
      },
    });

    const [row] = await database.execute<{ shape: string; endpoint: string }>(
      sql`select jsonb_typeof(override) as shape,
                 override->>'endpoint' as endpoint
          from channels where id = ${channelId}`,
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

    // The outbox row, before anything carries it to Intelligence: `record` and the payload inside it
    // are objects whose keys JSON operators reach, not strings holding them. A `record` stored as a
    // string is the row Intelligence refuses.
    const [row] = await database.execute<{
      record: string;
      shape: string;
      bot: string;
    }>(
      sql`select jsonb_typeof(record) as record,
                 jsonb_typeof(record->'payload') as shape,
                 record->'payload'->>'bot' as bot
          from audit_outbox
          where kind = 'event' and record->'target'->>'id' = ${`test_${suite}`}`,
    );

    expect(row?.record).toBe("object");
    expect(row?.shape).toBe("object");
    expect(row?.bot).toBe(marker);

    // And the same payload as Intelligence stored it: still an object with its own fields.
    const stored = await auditRows({ targetId: `test_${suite}` });
    expect(stored).toHaveLength(1);
    expect(typeof stored[0]?.payload).toBe("object");
    expect(stored[0]?.payload.bot).toBe(marker);
    // Left in place: the trail is append-only, so a test cannot tidy up after itself. One row.
  });
});

afterAll(async () => {
  await database.$client.close();
});
