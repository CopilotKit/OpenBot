import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  credentials,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { currentEdition, setEdition } from "../src/edition";
import { listTools as routinesListing } from "../src/plugins/builtin-routines";
import { listTools as driveListing } from "../src/plugins/google-drive-rest";
import {
  ALWAYS_ON_APP,
  ensureAlwaysOnApp,
  personalDefaultsDeps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * An upgrade brings the saved tools of OpenBot's own apps up to date with the build that starts.
 *
 * Routines' and Drive's tools are this code, but a deployment keeps the list the build that added the
 * app saved, and only an admin's Refresh used to replace it. So a release that reworded a tool never
 * reached an existing install: on OpenBot Desktop, which has no Admin page, a goal's trigger tools
 * kept telling the model about a page that had been renamed. These start the deployment the way
 * `index.ts` does (`ensureAlwaysOnApp` on the real plugin store, wrapped as boot wraps it), over the
 * rows an older build left.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = `own-tools-${randomUUID()}`;
const BOT = `${suite}-bot`;
const OTHER = `${suite}-other`;
const DRIVE = "google-drive";

const pluginStore = withPersonalDefaults(
  createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  }),
  personalDefaultsDeps(database),
);
/** Boot's own deps, narrowed to this file's Bots so the shared test database's other Bots are left alone. */
const deps = {
  ...personalDefaultsDeps(database),
  bots: async () => [BOT, OTHER],
};
const start = () => ensureAlwaysOnApp(pluginStore, deps);

let edition: ReturnType<typeof currentEdition>;
let routinesWereAdded = false;
let driveWasAdded = false;
let driveClient: string | undefined;

async function saved(serverId: string) {
  const rows = await database
    .select({ name: mcpTools.name, description: mcpTools.description })
    .from(mcpTools)
    .where(eq(mcpTools.serverId, serverId));
  return Object.fromEntries(rows.map((row) => [row.name, row.description]));
}
async function refreshedAt(serverId: string) {
  const [row] = await database
    .select({ at: mcpServers.toolsRefreshedAt })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  return row?.at?.toISOString() ?? null;
}
async function grantsOf(agentId: string, serverId: string) {
  const rows = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(eq(pluginGrants.agentId, agentId));
  return rows
    .map((row) => row.ref)
    .filter((ref) => ref.startsWith(`${serverId}/`))
    .sort();
}
const current = async (
  listing: () => Promise<{ name: string; description: string }[]>,
) =>
  Object.fromEntries(
    (await listing()).map((tool) => [tool.name, tool.description]),
  );

beforeAll(async () => {
  edition = currentEdition();
  setEdition("team");
  await database.insert(agents).values(
    [BOT, OTHER].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
  routinesWereAdded = Boolean(await pluginStore.serverAddress(ALWAYS_ON_APP));
  driveWasAdded = Boolean(await pluginStore.serverAddress(DRIVE));

  // The first start, on the build that added Routines.
  await start();

  // Drive, turned on by an admin and given to one Bot, its tools saved by that build.
  if (!driveWasAdded) {
    const [client] = await database
      .insert(credentials)
      .values({
        kind: "mcp_oauth_client",
        provider: `google-drive-${suite}`,
        keyId: "oauth-client",
        metadata: {},
        encryptedValue: "sealed",
      })
      .returning({ id: credentials.id });
    driveClient = client?.id;
    await database.insert(mcpServers).values({
      id: DRIVE,
      title: "Google Drive",
      vendor: "Google",
      url: "https://www.googleapis.com/drive/v3",
      provenance: "first-party",
      credentialId: driveClient ?? null,
    });
  }
  await database.delete(mcpTools).where(eq(mcpTools.serverId, DRIVE));
  await database.insert(mcpTools).values({
    serverId: DRIVE,
    name: "search",
    vendorName: "search",
    description: "An older build's words for Drive search.",
    inputSchema: { type: "object", properties: {} },
  });
  await database.insert(pluginGrants).values({
    kind: "mcp",
    ref: `${DRIVE}/search`,
    agentId: BOT,
    grantedBy: "admin",
  });

  // What an older build saved for Routines: older words, a tool since retired, one not yet written.
  await database
    .update(mcpTools)
    .set({ description: "An older build's words for create_trigger." })
    .where(
      and(
        eq(mcpTools.serverId, ALWAYS_ON_APP),
        eq(mcpTools.name, "create_trigger"),
      ),
    );
  await database
    .delete(mcpTools)
    .where(
      and(
        eq(mcpTools.serverId, ALWAYS_ON_APP),
        eq(mcpTools.name, "list_triggers"),
      ),
    );
  await database
    .delete(pluginGrants)
    .where(
      and(
        inArray(pluginGrants.agentId, [BOT, OTHER]),
        eq(pluginGrants.ref, `${ALWAYS_ON_APP}/list_triggers`),
      ),
    );
  await database.insert(mcpTools).values({
    serverId: ALWAYS_ON_APP,
    name: "retired_tool",
    vendorName: "retired_tool",
    description: "A tool an older build had.",
    inputSchema: { type: "object", properties: {} },
  });
});

afterAll(async () => {
  setEdition(edition);
  await database.delete(agents).where(inArray(agents.id, [BOT, OTHER]));
  if (!driveWasAdded) {
    await database.delete(mcpServers).where(eq(mcpServers.id, DRIVE));
    if (driveClient)
      await database.delete(credentials).where(eq(credentials.id, driveClient));
  } else await pluginStore.refreshTools(DRIVE);
  if (!routinesWereAdded)
    await database.delete(mcpServers).where(eq(mcpServers.id, ALWAYS_ON_APP));
  else await pluginStore.refreshTools(ALWAYS_ON_APP);
  await database.$client.end({ timeout: 5 });
});

describe("starting a newer build", () => {
  test("saves the tools Routines and Drive have in this build, and offers a Bot their words", async () => {
    await start();

    expect(await saved(ALWAYS_ON_APP)).toEqual(await current(routinesListing));
    expect(await saved(DRIVE)).toEqual(
      await current(() => driveListing({ url: "" })),
    );
    const offered = await pluginStore.listForAgent(BOT);
    const createTrigger = offered.tools.find(
      (tool) => tool.ref === `${ALWAYS_ON_APP}/create_trigger`,
    );
    expect(createTrigger?.description).toBe(
      (await routinesListing()).find((tool) => tool.name === "create_trigger")
        ?.description,
    );
  });

  test("gives every Bot a Routines tool this build added, at the same start", async () => {
    expect(await grantsOf(BOT, ALWAYS_ON_APP)).toContain(
      `${ALWAYS_ON_APP}/list_triggers`,
    );
    expect(await grantsOf(OTHER, ALWAYS_ON_APP)).toContain(
      `${ALWAYS_ON_APP}/list_triggers`,
    );
  });

  test("leaves what people decided alone: Drive is still on, and still only the one Bot's", async () => {
    expect(await pluginStore.serverAddress(DRIVE)).toBeTruthy();
    expect(await grantsOf(BOT, DRIVE)).toEqual([`${DRIVE}/search`]);
    expect(await grantsOf(OTHER, DRIVE)).toEqual([]);
  });

  test("writes nothing at a start where nothing changed", async () => {
    const before = [await refreshedAt(ALWAYS_ON_APP), await refreshedAt(DRIVE)];
    expect(await pluginStore.refreshOwnListings()).toEqual([]);
    await start();
    expect([
      await refreshedAt(ALWAYS_ON_APP),
      await refreshedAt(DRIVE),
    ]).toEqual(before);
  });
});
