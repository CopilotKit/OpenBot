import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { currentEdition, setEdition } from "../src/edition";
import { listTools as routinesListing } from "../src/plugins/builtin-routines";
import {
  ALWAYS_ON_APP,
  ensureAlwaysOnApp,
  personalDefaultsDeps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * What an upgrade that gives every Bot new tools leaves on the trail.
 *
 * Seen on Windows, upgrading the personal edition to a build whose Routines added seven goal tools:
 * Activity showed twenty-one rows at the moment the app started, one per tool for each of three
 * Bots, each "Started by a person". Nobody did anything. The grant names OpenBot as its actor
 * (`openbot:always-on`), and the row was written with no initiator, which the trail reads as a
 * person. These start the deployment the way `index.ts` does, over the rows an older build left,
 * against a real database.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `upgrade-grants-${randomUUID().slice(0, 8)}`;
const BOTS = [`${suite}-a`, `${suite}-b`, `${suite}-c`];

/** Boot's own reads, narrowed to this file's Bots so the shared test database's others are left alone. */
const deps = {
  ...personalDefaultsDeps(database),
  bots: async () => BOTS,
};
const pluginStore = withPersonalDefaults(
  createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  }),
  deps,
);
const start = () => ensureAlwaysOnApp(pluginStore, deps);

let edition: ReturnType<typeof currentEdition>;
let routinesWereAdded = false;
let goalTools: string[] = [];

/** Every configuration row about this file's Bots, oldest first. */
async function trail() {
  return database
    .select({
      id: auditEvents.id,
      initiatorKind: auditEvents.initiatorKind,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "configuration.changed"),
        inArray(sql`${auditEvents.payload}->>'bot'`, BOTS),
      ),
    )
    .orderBy(auditEvents.createdAt, auditEvents.id);
}

beforeAll(async () => {
  edition = currentEdition();
  setEdition("personal");
  await database.insert(agents).values(
    BOTS.map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
  routinesWereAdded = Boolean(await pluginStore.serverAddress(ALWAYS_ON_APP));
  goalTools = (await routinesListing())
    .map((tool) => tool.name)
    .filter((name) => /_goals?$/.test(name))
    .map((name) => `${ALWAYS_ON_APP}/${name}`)
    .sort();

  // The first start, on an older build.
  await start();

  // What that older build saved for Routines: no goal tools yet, so no Bot holds them.
  await database.delete(mcpTools).where(
    and(
      eq(mcpTools.serverId, ALWAYS_ON_APP),
      inArray(
        mcpTools.name,
        goalTools.map((ref) => ref.slice(ALWAYS_ON_APP.length + 1)),
      ),
    ),
  );
  await database
    .delete(pluginGrants)
    .where(
      and(
        inArray(pluginGrants.agentId, BOTS),
        inArray(pluginGrants.ref, goalTools),
      ),
    );
});

afterAll(async () => {
  setEdition(edition);
  await database.delete(agents).where(inArray(agents.id, BOTS));
  if (!routinesWereAdded)
    await database.delete(mcpServers).where(eq(mcpServers.id, ALWAYS_ON_APP));
  else await pluginStore.refreshTools(ALWAYS_ON_APP);
  await database.$client.end({ timeout: 5 });
});

describe("starting a build whose Routines has new tools", () => {
  test("writes one row per Bot naming every tool it was given, started by OpenBot", async () => {
    expect(goalTools.length).toBeGreaterThan(1);
    const before = new Set((await trail()).map((row) => row.id));

    await start();

    for (const bot of BOTS) {
      const held = await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, bot),
            inArray(pluginGrants.ref, goalTools),
          ),
        );
      expect(held.map((row) => row.ref).sort()).toEqual(goalTools);
    }

    const written = (await trail()).filter((row) => !before.has(row.id));
    expect(
      written
        .map((row) => ({
          initiatorKind: row.initiatorKind,
          targetType: row.targetType,
          targetId: row.targetId,
          payload: row.payload,
        }))
        .sort((left, right) =>
          String(left.payload.bot).localeCompare(String(right.payload.bot)),
        ),
    ).toEqual(
      BOTS.map((bot) => ({
        initiatorKind: "deployment",
        targetType: "mcp_server",
        targetId: ALWAYS_ON_APP,
        payload: {
          actor: "openbot:always-on",
          change: "plugin_granted",
          kind: "mcp",
          app: ALWAYS_ON_APP,
          refs: goalTools,
          bot,
        },
      })),
    );
  });

  test("a start with nothing new writes nothing", async () => {
    const before = (await trail()).length;
    await start();
    expect(await trail()).toHaveLength(before);
  });

  test("a person giving a Bot a tool is still started by a person", async () => {
    const [bot] = BOTS as [string];
    const before = new Set((await trail()).map((row) => row.id));
    await pluginStore.revoke("mcp", goalTools[0] as string, bot, "dev");
    await pluginStore.grant("mcp", goalTools[0] as string, bot, "dev");
    const written = (await trail()).filter((row) => !before.has(row.id));
    expect(written.map((row) => row.initiatorKind)).toEqual([
      "person",
      "person",
    ]);
  });
});
