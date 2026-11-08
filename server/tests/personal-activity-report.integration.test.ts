import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import { createComponentStore } from "../src/components/store";
import { createDatabase } from "../src/db/client";
import { auditEvents, components } from "../src/db/schema";
import { setEdition } from "../src/edition";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The Activity report in OpenBot Personal. Seen locally: asked for one, a Bot answered "Not shown:
 * Activity report. showActivityReport can't use the function botActivity. An admin has to give it
 * to this component." In the team edition an admin gives a component the data it reads; the
 * personal edition has no admin, so nothing ever did, and the report was refused in every install.
 *
 * Through the real component routes and store on a real database, as the app calls them: the build
 * announcing its components on a page load, the call's decision, and the card's read.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const store = createComponentStore(database);
const BOT = `report-bot-${randomUUID().slice(0, 8)}`;
const REPORT = "showActivityReport";

/** The Activity report as the build announces it (`galleryManifest` in the app). */
const MANIFEST = {
  components: [
    {
      name: REPORT,
      title: "Activity report",
      kind: "card",
      description: "Show what this deployment has actually been doing.",
    },
  ],
};

const person: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "dev-local-user",
    email: "person@openbot.test",
    role: "admin",
  });
  await next();
};

const app = new Hono().route(
  "/api/components",
  createComponentRoutes(store, person, auditStore, async () => true),
);

async function send(path: string, method: string, body: unknown) {
  const response = await app.request(`/api/components${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

const pageLoad = () => send("/catalogue", "PUT", MANIFEST);
const decide = () =>
  send(`/${REPORT}/decision`, "POST", {
    agentId: BOT,
    functions: ["botActivity"],
  });
const read = () =>
  send(`/${REPORT}/call`, "POST", {
    agentId: BOT,
    function: "botActivity",
    args: { days: 7 },
  });

/** When the running test began: the trail is append-only, so a test reads only its own rows. */
let since = "";

/** The rows this test left about the report, oldest first. */
async function rows(eventType: string) {
  const found = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, eventType),
        eq(auditEvents.targetId, REPORT),
        sql`${auditEvents.createdAt} >= ${since}::timestamptz`,
      ),
    )
    .orderBy(auditEvents.createdAt);
  return found.map((row) => ({
    functions: (row.payload as Record<string, unknown>).functions,
    initiatorKind: row.initiatorKind,
  }));
}

/** No component, so no grants: each test starts as a fresh install would. */
async function forget() {
  await database.delete(components).where(eq(components.name, REPORT));
  // The database's clock, which stamps the rows, not this process's.
  const [now] = await database.execute<{ now: string }>(
    sql`select clock_timestamp()::text as now`,
  );
  since = String(now?.now);
}

beforeAll(async () => {
  await forget();
  // This Bot's week, as the trail holds it: enough actions to be among the twelve a report shows.
  await database.execute(
    sql`insert into audit_events (event_type, target_type, target_id, payload)
        select 'computer.action_allowed', 'computer', ${BOT},
               jsonb_build_object('bot', ${BOT}::text, 'action', 'computer_read')
        from generate_series(1, 400)`,
  );
});

afterEach(async () => {
  setEdition("team");
  await forget();
});

afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

describe("the Activity report in OpenBot Personal", () => {
  test("a Bot draws it with real figures, OpenBot having given it the data on the first page load", async () => {
    setEdition("personal");
    await pageLoad();

    expect(await decide()).toEqual({ allowed: true });
    const answer = await read();
    expect(answer.allowed).toBe(true);
    const data = answer.data as {
      days: number;
      rows: { bot: string; actions: number }[];
    };
    expect(data.days).toBe(7);
    expect(data.rows.find((row) => row.bot === BOT)).toEqual({
      bot: BOT,
      actions: 400,
    });

    /*
     * Given by OpenBot, once, whatever page loads follow, in one row naming both. Seen on Windows: a
     * row per function drew two identical "Let a component read data / Activity report" rows.
     */
    await pageLoad();
    expect(await rows("component.function_granted")).toEqual([
      {
        functions: ["botActivity", "recentRefusals"],
        initiatorKind: "deployment",
      },
    ]);
  });

  test("two page loads announcing at once give the data once, in one row", async () => {
    setEdition("personal");
    await Promise.all([pageLoad(), pageLoad(), pageLoad()]);
    expect(await rows("component.function_granted")).toEqual([
      {
        functions: ["botActivity", "recentRefusals"],
        initiatorKind: "deployment",
      },
    ]);
  });

  test("an install from before is given the data on its next page load", async () => {
    // The component arrived on an earlier build, which gave it nothing.
    await pageLoad();
    setEdition("personal");
    expect(await decide()).toMatchObject({ allowed: false });

    await pageLoad();
    expect(await decide()).toEqual({ allowed: true });
    expect((await read()).allowed).toBe(true);
  });

  test("a refusal never sends the person to an admin", async () => {
    setEdition("personal");
    await pageLoad();
    await store.revokeFunction(REPORT, "botActivity");

    const decision = await decide();
    expect(decision).toEqual({
      allowed: false,
      reason: "It can't read the data it needs.",
    });
    expect(JSON.stringify(await read())).not.toContain("admin");
  });
});

describe("the Activity report in the team edition", () => {
  test("is given nothing until an admin gives it, and says so", async () => {
    await pageLoad();
    expect(await decide()).toEqual({
      allowed: false,
      reason:
        "showActivityReport can't use the function botActivity. An admin has to give it to this component.",
    });
    expect(await rows("component.function_granted")).toEqual([]);
  });
});
