import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../../src/audit";
import type { AppVariables } from "../../src/auth/guards";
import { createCredentialStore } from "../../src/credentials";
import { createDatabase } from "../../src/db/client";
import {
  agentProfiles,
  agents,
  appAccessRequests,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../../src/db/schema";
import { redirectUriFor } from "../../src/plugins/oauth";
import {
  personalDefaultsDeps,
  withPersonalDefaults,
} from "../../src/plugins/personal-defaults";
import { createPluginRoutes } from "../../src/plugins/routes";
import { createPluginStore } from "../../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./database";

/**
 * The server's `/api/plugins` routes as OpenBot Personal mounts them, over the test database, for a
 * browser test that wants the real answers rather than a copy of their shapes.
 *
 * Wired the way `index.ts` and `app.ts` wire them: the personal edition's defaults wrap the store,
 * and the connect flow has a public address and a key. One person, who is the admin, and one Bot.
 * The vendors are not here: whoever uses this answers their hosts on `globalThis.fetch`.
 *
 * It only names catalogue apps the caller says it will touch, and refuses to start when one of them
 * already has a row, because a catalogue key is shared by the whole suite and its tools would be
 * replaced.
 */
export function personalPluginRoutes(input: {
  suite: string;
  /** Catalogue keys the test may turn on, which are deleted again by `clear`. */
  apps: string[];
}) {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const personId = `person_${input.suite}`;
  const botId = `bot_${input.suite}`;
  const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const PUBLIC_URL = "https://openbot.test";

  const realVault = createCredentialStore(database);
  const createdCredentials = new Set<string>();
  const vault = {
    ...realVault,
    create: async (
      value: Parameters<typeof realVault.create>[0],
      executor?: Parameters<typeof realVault.create>[1],
    ) => {
      const row = await realVault.create(value, executor);
      createdCredentials.add(row.id);
      return row;
    },
    rotate: async (
      value: Parameters<typeof realVault.rotate>[0],
      executor?: Parameters<typeof realVault.rotate>[1],
    ) => {
      const row = await realVault.rotate(value, executor);
      createdCredentials.add(row.id);
      return row;
    },
  };

  const store = withPersonalDefaults(
    createPluginStore({
      brokerProvider: "composio",
      database,
      auditStore: createAuditStore(database),
      credentials: vault,
      encryptionKey: KEY,
      policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      redirectUri: redirectUriFor(PUBLIC_URL),
    }),
    personalDefaultsDeps(database),
  );

  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: personId,
      email: `${personId}@openbot.test`,
      role: "admin",
    } as never);
    await next();
  };

  const hono = new Hono().route(
    "/api/plugins",
    createPluginRoutes(store, signedIn, async () => true, {
      publicUrl: PUBLIC_URL,
      appUrl: "https://app.openbot.test",
      encryptionKey: KEY,
      personHasAccess: async (userId) => userId === personId,
    }),
  );

  async function clear() {
    await database
      .delete(appAccessRequests)
      .where(eq(appAccessRequests.requestedBy, personId));
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
    await database
      .delete(mcpUserCredentials)
      .where(eq(mcpUserCredentials.userId, personId));
    await database
      .delete(mcpTools)
      .where(inArray(mcpTools.serverId, input.apps));
    await database.delete(mcpServers).where(inArray(mcpServers.id, input.apps));
    if (createdCredentials.size > 0) {
      await database
        .delete(credentials)
        .where(inArray(credentials.id, [...createdCredentials]));
      createdCredentials.clear();
    }
  }

  return {
    personId,
    botId,
    /** What the browser's `fetch` of an `/api/plugins/...` path is answered with. */
    request: (path: string, init?: RequestInit) => hono.request(path, init),
    /** Turns an app on the way the Connections page does, before any sign-in. */
    addApp: (key: string) => store.addServer({ key, by: personId }),
    /** The refs of the tools the Bot holds on one app. */
    async botHolds(app: string): Promise<string[]> {
      const rows = await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(eq(pluginGrants.agentId, botId));
      return rows
        .map((row) => row.ref)
        .filter((ref) => ref.startsWith(`${app}/`));
    },
    async seed() {
      const [existing] = await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(inArray(mcpServers.id, input.apps));
      if (existing)
        throw new Error(
          `The test database already has a ${existing.id} row, so this suite will not run against it.`,
        );
      await database
        .insert(users)
        .values({
          id: personId,
          email: `${personId}@openbot.test`,
          name: personId,
          emailVerified: false,
        })
        .onConflictDoNothing();
      await database
        .insert(agents)
        .values({ id: botId, name: botId, type: "built_in", configuration: {} })
        .onConflictDoNothing();
      // Nobody's own Bot, like the Personal Assistant, so the card offers Connect in every state.
      await database
        .insert(agentProfiles)
        .values({
          agentId: botId,
          title: "",
          roleDescription: "",
          avatarSeed: botId,
          visibility: "public",
        })
        .onConflictDoNothing();
    },
    clear,
    async close() {
      await clear();
      await database
        .delete(agentProfiles)
        .where(eq(agentProfiles.agentId, botId));
      await database.delete(agents).where(eq(agents.id, botId));
      await database.delete(users).where(eq(users.id, personId));
      await database.$client.end({ timeout: 5 });
    },
  };
}
