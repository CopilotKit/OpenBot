import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CALLS_RECORDED_AS_CHANGES,
  OPENBOT_WORKING_EVENT_TYPES,
  oneRowPerAction,
} from "@openbot/shared/activity-rows";
import { sql } from "drizzle-orm";
import {
  createAuditReader,
  createAuditStore,
  recordAuditEvent,
} from "../src/audit";
import { dataFunction } from "../src/components/functions";
import { createDatabase } from "../src/db/client";
import { setEdition } from "../src/edition";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The Activity report counts what the person's Activity page shows. Seen on Windows (personal
 * edition): the report drew "Bot activity this week / Errand Helper 45" while Settings > Activity
 * listed 23 of that Bot's rows. The other 22 were choosing tools for a run, which the page leaves
 * out, and routing rows were counted too.
 *
 * On a real database: the Bot's rows as the server records them, the page's count from the reader
 * with the page's own query and the page's one-row-per-action rule, and the report's figure from
 * the data function the card reads.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const reader = createAuditReader(database);
const BOT = `counted-bot-${randomUUID().slice(0, 8)}`;

/** Enough of this Bot's own actions to be among the twelve Bots a report shows. */
const ACTIONS = 600;

async function record(
  eventType: Parameters<typeof recordAuditEvent>[1]["eventType"],
  fields: { targetType: string; targetId?: string; payload: object },
) {
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: fields.targetType,
    ...(fields.targetId ? { targetId: fields.targetId } : {}),
    payload: fields.payload as Record<string, unknown>,
  });
}

beforeAll(async () => {
  await database.execute(
    sql`insert into audit_events (event_type, target_type, target_id, payload)
        select 'computer.action_allowed', 'computer', ${BOT},
               jsonb_build_object('bot', ${BOT}::text, 'action', 'computer_read')
        from generate_series(1, ${ACTIONS})`,
  );
  // Three turns: each chose tools and routed its message, which the page leaves out.
  for (let turn = 0; turn < 3; turn++) {
    await record("mcp.tools_discovered", {
      targetType: "bot",
      targetId: BOT,
      payload: { bot: BOT, reason: "unavailable", granted: 96, offered: 96 },
    });
    await record("channel.routed", {
      targetType: "agent",
      targetId: BOT,
      payload: { chosen: BOT, reason: "fallback: one-candidate" },
    });
  }
  // A folder write the person denied: written as it went to the desktop, then refused. One row.
  const attempt = randomUUID();
  await record("computer.action_allowed", {
    targetType: "host_access",
    targetId: "grant-1",
    payload: { bot: BOT, action: "host/write_file", file: "todo.txt", attempt },
  });
  await record("computer.action_refused", {
    targetType: "host_access",
    targetId: "grant-1",
    payload: {
      bot: BOT,
      action: "host/write_file",
      file: "todo.txt",
      attempt,
      refusal: "person_declined",
    },
  });
  // Rows the page lists under this Bot that do not name it as `bot`.
  await record("configuration.changed", {
    targetType: "host_access",
    targetId: "grant-1",
    payload: { change: "host_folder_granted", botId: BOT },
  });
  await record("bot.paused", {
    targetType: "agent",
    targetId: BOT,
    payload: {},
  });
  /*
   * The Bot creating a routine: its call to Routines, and the routine the routine store recorded.
   * One action. A second call that failed made no routine and is its own row.
   */
  await record("mcp.call_succeeded", {
    targetType: "mcp_tool",
    targetId: "routines/create_routine",
    payload: { bot: BOT, tool: "create_routine" },
  });
  await record("routine.created", {
    targetType: "routine",
    targetId: randomUUID(),
    payload: {
      agentId: BOT,
      channelId: null,
      cron: "0 9 * * *",
      timezone: "UTC",
    },
  });
  await record("mcp.call_failed", {
    targetType: "mcp_tool",
    targetId: "routines/create_routine",
    payload: { bot: BOT, tool: "create_routine", failure: "Invalid schedule." },
  });
});

/** The page's own query for this Bot, as `withoutOpenBotWorking` writes it. */
async function shownOnActivity() {
  const { events } = await reader.list({
    limit: ACTIONS + 100,
    bot: BOT,
    excludeEventType: OPENBOT_WORKING_EVENT_TYPES.join(","),
    excludeCalls: CALLS_RECORDED_AS_CHANGES.join(","),
  });
  return oneRowPerAction(events);
}

afterEach(() => setEdition("team"));

afterAll(async () => {
  await database.$client.end({ timeout: 5 });
});

/** The report's figure for this Bot, from the function the card reads. */
async function reported() {
  const report = dataFunction("botActivity");
  if (!report) throw new Error("botActivity is not shipped");
  const { rows } = (await report.run(database, { days: 7 })) as {
    rows: { bot: string; actions: number }[];
  };
  return rows.find((row) => row.bot === BOT)?.actions;
}

describe("the Activity report's count for a Bot", () => {
  test("in the personal edition is the number of rows Activity shows for it", async () => {
    setEdition("personal");
    const shown = (await shownOnActivity()).length;
    /*
     * Its own actions, the denied write once, the folder it was given, its pause, the routine it
     * made once, and the call that failed.
     */
    expect(shown).toBe(ACTIONS + 5);
    expect(await reported()).toBe(shown);
  });

  test("in the team edition counts what it counted before: every row naming the Bot", async () => {
    const [named] = await database.execute<{ count: number }>(
      sql`select count(*)::int as count from audit_events where payload->>'bot' = ${BOT}`,
    );
    expect(await reported()).toBe(named?.count);
  });
});

describe("a Bot creating a routine", () => {
  test("is one row on Activity, the routine, under the Bot that runs it", async () => {
    const routineRows = (await shownOnActivity())
      .filter(
        (event) =>
          event.eventType === "routine.created" ||
          event.targetId === "routines/create_routine",
      )
      .map((event) => event.eventType);
    expect(routineRows).toEqual(["mcp.call_failed", "routine.created"]);
  });
});
