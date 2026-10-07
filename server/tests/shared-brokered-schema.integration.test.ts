// server/tests/shared-brokered-schema.integration.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { brokeredConnections } from "../src/db/schema/plugins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const app = `schema-${suite}`;

/** The constraint a failed insert names, read from the driver's cause rather than drizzle's wrapper. */
const violation = (run: () => PromiseLike<unknown>) =>
  Promise.resolve()
    .then(run)
    .then(
      () => "inserted",
      (error: Error) =>
        String((error.cause as Error | undefined)?.message ?? error.message),
    );

afterAll(async () => {
  await database.execute(
    sql`delete from brokered_connections where app = ${app}`,
  );
});

describe("brokered_connections", () => {
  test("a deployment row may not name a person", async () => {
    expect(
      await violation(() =>
        database.insert(brokeredConnections).values({
          provider: "composio",
          app,
          holder: "deployment",
          userId: "someone",
          vendorUserId: `openbot-deployment:x:${suite}`,
        }),
      ),
    ).toMatch(/brokered_connections_holder_check/);
  });

  test("a person row must name the person", async () => {
    expect(
      await violation(() =>
        database.insert(brokeredConnections).values({
          provider: "composio",
          app,
          holder: "person",
          userId: null,
          vendorUserId: "v",
        }),
      ),
    ).toMatch(/brokered_connections_holder_check/);
  });

  test("an app holds at most one deployment account", async () => {
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app,
      holder: "deployment",
      vendorUserId: `d1-${suite}`,
    });
    expect(
      await violation(() =>
        database.insert(brokeredConnections).values({
          provider: "composio",
          app,
          holder: "deployment",
          vendorUserId: `d2-${suite}`,
        }),
      ),
    ).toMatch(/brokered_connections_deployment_idx/);
  });

  test("one person holds at most one account per app, and two people may each hold one", async () => {
    await database.insert(brokeredConnections).values([
      {
        provider: "composio",
        app,
        holder: "person",
        userId: `a-${suite}`,
        vendorUserId: `a-${suite}`,
      },
      {
        provider: "composio",
        app,
        holder: "person",
        userId: `b-${suite}`,
        vendorUserId: `b-${suite}`,
      },
    ]);
    expect(
      await violation(() =>
        database.insert(brokeredConnections).values({
          provider: "composio",
          app,
          holder: "person",
          userId: `a-${suite}`,
          vendorUserId: `a-${suite}`,
        }),
      ),
    ).toMatch(/brokered_connections_person_idx/);
  });

  test("composio_connections is still there for a rolled-back v0.1.0", async () => {
    const [row] = await database.execute<{ exists: boolean }>(
      sql`select to_regclass('public.composio_connections') is not null as exists`,
    );
    expect(row?.exists).toBe(true);
  });
});
