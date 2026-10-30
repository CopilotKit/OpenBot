// server/tests/composio-connect-adopts-held-account.test.ts
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ComposioMultipleConnectedAccountsError } from "@composio/core";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { auditEvents, brokeredConnections, mcpServers } from "../src/db/schema";
import {
  buildComposioClient,
  type ComposioVendor,
} from "../src/plugins/composio-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * PRESSING CONNECT ON AN APP COMPOSIO ALREADY HOLDS AN ACCOUNT FOR, WITH NO ROW FOR IT HERE.
 *
 * WHAT WAS SEEN. A person pressed Connect on GitHub and was told Composio "already holds a
 * connected account for github", and that what clears it is "disconnecting the account they
 * already hold, on this deployment's Connected accounts page". That page drew GitHub as not
 * connected and offered no Disconnect. Composio held an ACTIVE account for the person and this
 * deployment had no `brokered_connections` row for it: a fresh or upgraded install, or, in
 * single-user mode, every local install signing in as the same person against one Composio key.
 * The confirm route already heals exactly this drift when a page loads; Connect never asked it to.
 *
 * WHAT IS ASSERTED. The press records the account the vendor holds, through the same store call
 * confirm makes, and answers `{ connected: true }`. Where the vendor refuses a second link and then
 * answers that it holds nothing, the press is still a refusal, and it no longer sends anybody to
 * disconnect an account their page does not show. A Shared app's account is still only ever
 * recorded by an administrator.
 *
 * THE REAL ROUTE, THE REAL STORE, THE REAL COMPOSIO ADAPTER, AND A VENDOR THAT ANSWERS AS THE SDK
 * DOES. Only the vendor's client is a double, and the one call this bug turns on is written to do
 * what `@composio/core` 0.18.1's `ConnectedAccounts.link` does: list the person's ACTIVE accounts
 * on that auth config first and throw the SDK's own `ComposioMultipleConnectedAccountsError`, with
 * the SDK's own message, where it finds one. Every listing honours the query it is given, for the
 * reason `composio-grants-for.test.ts` gives: a fake that answers every question with every row
 * cannot tell a question about this person from one about somebody else.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const PERSON = `person-${suite}`;
const ADMIN = `admin-${suite}`;
/** Somebody else at this deployment, who holds an account the person pressing Connect does not. */
const OTHER = `other-${suite}`;
const DEPLOYMENT = `openbot-deployment:acme-${suite}:R`;

/**
 * Every app a test here makes, so the afterEach can take its rows back.
 *
 * ONE SLUG PER TEST, because `audit_events` is append-only and no clean-up can reach it: a test
 * counting `mcp.account_connected` rows under an app would otherwise be counting another test's.
 */
const made: string[] = [];

/** The vendor's account statuses, spelled here because the adapter keeps its copy private. */
type AccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

/** An account as Composio holds it: whose, which app, which auth config, and in what state. */
type HeldAccount = {
  id: string;
  userId: string;
  toolkit: string;
  config: string;
  status: AccountStatus;
};

/** A vendor method nothing in a given test should reach, which says so rather than answering. */
const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};

/**
 * Composio as this suite needs it: one app's auth config (ours), the accounts it holds, and a
 * record of what was asked.
 *
 * `afterRefusedLink` RUNS BETWEEN THE VENDOR REFUSING A LINK AND ANYTHING ASKING IT AGAIN, which is
 * the one moment a race with somebody ending the account in Composio's own dashboard can land in.
 */
function composioHolding(
  toolkit: string,
  accounts: HeldAccount[],
  options: { afterRefusedLink?: () => void } = {},
) {
  const config = {
    id: `ac_${toolkit}`,
    name: `${toolkit} (OpenBot)`,
    status: "ENABLED",
  };
  const asked = { listed: 0, minted: [] as string[] };

  const vendor: ComposioVendor = {
    tools: {
      list: refuse("tools.list"),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: async (query) => ({
        items: query.toolkit === toolkit ? [config] : [],
        nextCursor: null,
      }),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: async (query) => {
        asked.listed += 1;
        return {
          items: accounts
            .filter(
              (account) =>
                query.userIds.includes(account.userId) &&
                query.toolkitSlugs.includes(account.toolkit) &&
                query.statuses.some((status) => status === account.status) &&
                // Absent means every config, which is what the vendor does with no filter at all.
                (query.authConfigIds === undefined ||
                  query.authConfigIds.includes(account.config)),
            )
            .map((account) => ({
              id: account.id,
              status: account.status,
              authConfig: { id: account.config },
              toolkit: { slug: account.toolkit },
            })),
          nextCursor: null,
        };
      },
      /*
       * `@composio/core` 0.18.1, `ConnectedAccounts.link` (`dist/index.mjs:3211-3220`), line for
       * line in what it decides: `this.list({ userIds: [userId], authConfigIds: [authConfigId],
       * statuses: [ACTIVE] })`, and `if (existing.items.length > 0 && !opts.allowMultiple) throw new
       * ComposioMultipleConnectedAccountsError(...)` with this exact message. This deployment never
       * sends `allowMultiple`, so the refusal is unconditional on a held account.
       */
      link: async (userId, authConfigId, linkOptions) => {
        const existing = accounts.filter(
          (account) =>
            account.userId === userId &&
            account.config === authConfigId &&
            account.status === "ACTIVE",
        );
        if (existing.length > 0) {
          options.afterRefusedLink?.();
          throw new ComposioMultipleConnectedAccountsError(
            `Multiple connected accounts found for user ${userId} in auth config ${authConfigId}. Please use the allowMultiple option to allow multiple connected accounts.`,
          );
        }
        asked.minted.push(userId);
        return {
          redirectUrl: `https://connect.composio.test/link/${userId}?back=${encodeURIComponent(linkOptions.callbackUrl)}`,
        };
      },
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
    },
  };

  return { broker: buildComposioClient(vendor).broker, config, asked };
}

/** One ACTIVE account Composio holds for `userId` on this deployment's own config for `toolkit`. */
function heldBy(userId: string, toolkit: string): HeldAccount {
  return {
    id: `ca_${userId}_${toolkit}`,
    userId,
    toolkit,
    config: `ac_${toolkit}`,
    status: "ACTIVE",
  };
}

/** The app's row, as enabling it writes one: a consent app, Personal or Shared. */
async function enable(toolkit: string, mode: "personal" | "shared") {
  made.push(toolkit);
  await database.insert(mcpServers).values({
    id: toolkit,
    title: "GitHub",
    vendor: "Composio",
    url: `composio://${toolkit}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: mode,
    sharedVendorUserId: mode === "shared" ? DEPLOYMENT : null,
  });
}

/** The real routes over the real store, signed in as `id` with `role`. */
function signedInAs(
  broker: ReturnType<typeof composioHolding>["broker"],
  id: string,
  role: "admin" | "user",
) {
  const store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id, email: `${id}@example.test`, role } as never);
    await next();
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      session,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, provider: "composio" },
    ),
  );
}

const pressConnect = (
  app: ReturnType<typeof signedInAs>,
  toolkit: string,
  body?: unknown,
) =>
  app.request(`/api/plugins/servers/${toolkit}/connect`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

const rowsFor = (toolkit: string) =>
  database
    .select()
    .from(brokeredConnections)
    .where(eq(brokeredConnections.app, toolkit));

const connectedTrail = (toolkit: string) =>
  database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_connected"),
        eq(auditEvents.targetId, toolkit),
      ),
    );

afterEach(async () => {
  if (made.length === 0) return;
  await database
    .delete(brokeredConnections)
    .where(inArray(brokeredConnections.app, made));
  await database.delete(mcpServers).where(inArray(mcpServers.id, made));
  made.length = 0;
});

afterAll(async () => {
  await database.$client.end();
});

describe("Connect, where Composio already holds this person's account and OpenBot has no row", () => {
  test("records the account Composio holds and answers connected, as confirm would", async () => {
    const toolkit = `github-${suite}-held`;
    await enable(toolkit, "personal");
    const composio = composioHolding(toolkit, [heldBy(PERSON, toolkit)]);

    const response = await pressConnect(
      signedInAs(composio.broker, PERSON, "user"),
      toolkit,
    );

    // The shape confirm answers with, which the browser already reads as connected.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    // No consent link was minted: the vendor refused it, and there is nothing to finish anywhere.
    expect(composio.asked.minted).toEqual([]);

    // The row confirm writes for a consent app the vendor says yes for: this person's own. The
    // store records `connected_by` only for a deployment account, whose connector is not its holder.
    // The two ids are equal because production writes them equal for a person (`personAccount`);
    // this expects that production equality rather than independent fixture identities.
    const rows = await rowsFor(toolkit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "composio",
      holder: "person",
      userId: PERSON,
      vendorUserId: PERSON,
      connectedBy: null,
      verified: true,
      probeAction: null,
    });

    // And the trail row confirm files for a connection it records for the first time, once.
    const trail = await connectedTrail(toolkit);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.payload).toMatchObject({
      actor: PERSON,
      server: toolkit,
      holder: "person",
      reconnected: false,
    });

    // The connections list now draws it as theirs, which is what the Connect card watches for.
    const listed = await signedInAs(composio.broker, PERSON, "user").request(
      "/api/plugins/connections",
    );
    const { connections } = (await listed.json()) as {
      connections: { serverId: string; holder: string }[];
    };
    expect(connections).toContainEqual(
      expect.objectContaining({ serverId: toolkit, holder: "person" }),
    );
  });

  test("whose account is recorded comes from the session, never from the request", async () => {
    // Somebody else holds an account; the person pressing does not, and names the other in the body.
    const toolkit = `github-${suite}-body`;
    await enable(toolkit, "personal");
    const composio = composioHolding(toolkit, [heldBy(OTHER, toolkit)]);

    const response = await pressConnect(
      signedInAs(composio.broker, PERSON, "user"),
      toolkit,
      { holder: "person", vendorUserId: OTHER },
    );

    // An ordinary consent link, minted for the person signed in, and nobody's account recorded.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl?: string };
    expect(body.authorizationUrl).toStartWith(
      `https://connect.composio.test/link/${PERSON}?`,
    );
    expect(composio.asked.minted).toEqual([PERSON]);
    expect(await rowsFor(toolkit)).toEqual([]);
    expect(await connectedTrail(toolkit)).toEqual([]);
  });

  test("a refusal whose account is gone when it is checked stays a refusal, and sends nobody to disconnect", async () => {
    /*
     * Composio refuses the link because it holds an ACTIVE account, and the account is ended in
     * its own dashboard before anything here asks again. So the vendor's two answers disagree, and
     * the honest end is no row and a sentence that matches the page: nothing to disconnect here.
     */
    const toolkit = `github-${suite}-gone`;
    await enable(toolkit, "personal");
    const accounts = [heldBy(PERSON, toolkit)];
    const composio = composioHolding(toolkit, accounts, {
      afterRefusedLink: () => {
        accounts.length = 0;
      },
    });

    const response = await pressConnect(
      signedInAs(composio.broker, PERSON, "user"),
      toolkit,
    );

    expect(response.status).toBe(409);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("Nothing was connected.");
    expect(error).toContain("Press Connect again");
    // The page this person is on shows no account and no Disconnect, so the sentence names neither.
    expect(error).not.toMatch(/disconnect/i);
    // Spoken to whoever pressed Connect, so it names no broker. See routes-vendor-vocabulary.
    expect(error).not.toMatch(/Composio/);
    // The vendor was asked again, and its no is what was recorded: no row, no trail.
    expect(composio.asked.listed).toBeGreaterThan(0);
    expect(await rowsFor(toolkit)).toEqual([]);
    expect(await connectedTrail(toolkit)).toEqual([]);
  });
});

describe("Connect on a Shared app whose team account Composio already holds", () => {
  test("a non-admin is refused before the vendor is asked, and nothing is recorded", async () => {
    const toolkit = `github-${suite}-shared-user`;
    await enable(toolkit, "shared");
    const composio = composioHolding(toolkit, [heldBy(DEPLOYMENT, toolkit)]);

    const response = await pressConnect(
      signedInAs(composio.broker, PERSON, "user"),
      toolkit,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Only an admin can connect shared apps.",
    });
    expect(composio.asked.listed).toBe(0);
    expect(composio.asked.minted).toEqual([]);
    expect(await rowsFor(toolkit)).toEqual([]);
    expect(await connectedTrail(toolkit)).toEqual([]);
  });

  test("an admin's press records the team account under the deployment, as confirm would", async () => {
    const toolkit = `github-${suite}-shared-admin`;
    await enable(toolkit, "shared");
    const composio = composioHolding(toolkit, [heldBy(DEPLOYMENT, toolkit)]);

    const response = await pressConnect(
      signedInAs(composio.broker, ADMIN, "admin"),
      toolkit,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    expect(composio.asked.minted).toEqual([]);

    const rows = await rowsFor(toolkit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      holder: "deployment",
      userId: null,
      vendorUserId: DEPLOYMENT,
      connectedBy: ADMIN,
    });
    const trail = await connectedTrail(toolkit);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.payload).toMatchObject({
      actor: ADMIN,
      server: toolkit,
      holder: "deployment",
    });
  });
});

afterAll(async () => {
  await database.$client.close();
});
