import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ComposioMultipleConnectedAccountsError } from "@composio/core";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { z } from "zod";
import { equivalenceOf } from "../src/approvals/service";
import type { ApprovalCandidate, ApprovalGate } from "../src/approvals/types";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agents,
  brokeredAccounts,
  brokeredConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { useComposioClient } from "../src/plugins/composio";
import {
  buildComposioClient,
  type ComposioVendor,
} from "../src/plugins/composio-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A PERSON WITH TWO GMAIL ACCOUNTS, AND A BOT THAT CAN USE EACH ONE.
 *
 * WHAT WAS SEEN. Somebody with a work and a personal Gmail pressed Connect a second time and was told
 * "You already have an account connected to Gmail. Disconnect it first if you want to connect a
 * different one." Every call ran in whichever account Composio picked, so a second mailbox could not
 * be connected at all.
 *
 * WHAT IS ASSERTED. The app page lists both accounts by the address Composio reports. A second
 * Connect mints a link that asks for another account. A call naming the second address runs in the
 * second connected account's id; a call naming an address the person does not hold, including
 * somebody else's, is refused before the vendor is asked; a call naming none runs in the default. A
 * connection made before accounts were listed calls exactly as it did.
 *
 * THE REAL ROUTES, THE REAL STORE, THE REAL COMPOSIO ADAPTER AND TRANSPORT. Only Composio's client
 * is a double, and its connected accounts are the shape `@composio/core` 0.18.1 hands over after
 * `transformConnectedAccountResponse`: the raw item spread with the camelCase fields beside it, the
 * address in `data.displayName` and `state.val.displayName`, tokens beside it that nothing may read.
 * Every listing honours the query it was given, so a question about one person cannot be answered
 * with another's accounts.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const PERSON = `person-${suite}`;
/** Somebody else at this deployment, with a Gmail of their own. */
const OTHER = `other-${suite}`;
const BOT = `bot-multi-${suite}`;
const WORK = "dana@work.example";
const HOME = "dana.home@gmail.example";
const THEIRS = "someone.else@work.example";

const made: string[] = [];

type HeldAccount = {
  id: string;
  userId: string;
  toolkit: string;
  email: string | null;
  createdAt: string;
  status: "ACTIVE" | "EXPIRED";
};

const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};

/** A connected account as the SDK's listing hands it over, tokens and all. */
function vendorRow(account: HeldAccount, config: string) {
  const val = {
    status: account.status,
    ...(account.email ? { displayName: account.email } : {}),
    scope: "https://www.googleapis.com/auth/gmail.modify",
    access_token: "ya29.not-a-real-token",
    refresh_token: "1//not-a-real-refresh-token",
    id_token: "eyJ.not-a-real-id-token",
    token_type: "Bearer",
    expires_in: 3599,
  };
  return {
    id: account.id,
    word_id: `gmail_${account.id}`,
    wordId: `gmail_${account.id}`,
    alias: null,
    user_id: account.userId,
    status: account.status,
    status_reason: null,
    statusReason: null,
    is_disabled: false,
    isDisabled: false,
    toolkit: { slug: account.toolkit },
    auth_config: {
      id: config,
      auth_scheme: "OAUTH2",
      is_composio_managed: true,
      is_disabled: false,
    },
    authConfig: {
      id: config,
      authScheme: "OAUTH2",
      isComposioManaged: true,
      isDisabled: false,
    },
    data: val,
    state: { authScheme: "OAUTH2", val },
    created_at: account.createdAt,
    createdAt: account.createdAt,
    updated_at: account.createdAt,
    updatedAt: account.createdAt,
  };
}

/** Composio holding `accounts` for one app, recording what it was asked. */
function composioHolding(toolkit: string, accounts: HeldAccount[]) {
  const config = `ac_${toolkit}`;
  const asked = {
    links: [] as { userId: string; allowMultiple: boolean }[],
    executed: [] as { userId: string; connectedAccountId?: string }[],
    deleted: [] as string[],
  };
  const vendor: ComposioVendor = {
    tools: {
      list: refuse("tools.list"),
      getRawComposioToolBySlug: async (slug) =>
        ({
          slug,
          toolkit: { slug: toolkit },
          inputParameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        }) as never,
      execute: async (_slug, body) => {
        asked.executed.push({
          userId: body.userId,
          ...(body.connectedAccountId === undefined
            ? {}
            : { connectedAccountId: body.connectedAccountId }),
        });
        return { data: { messages: [] }, error: null, successful: true };
      },
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: async (query) => ({
        items:
          query.toolkit === toolkit
            ? [{ id: config, name: `${toolkit} (OpenBot)`, status: "ENABLED" }]
            : [],
        nextCursor: null,
      }),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: async (query) => ({
        items: accounts
          .filter(
            (account) =>
              query.userIds.includes(account.userId) &&
              query.toolkitSlugs.includes(account.toolkit) &&
              query.statuses.some((status) => status === account.status) &&
              (query.authConfigIds === undefined ||
                query.authConfigIds.includes(config)),
          )
          .map((account) => vendorRow(account, config)),
        nextCursor: null,
      }),
      // `@composio/core` 0.18.1 `ConnectedAccounts.link`: refuses a held account unless asked for more.
      link: async (userId, authConfigId, options) => {
        const held = accounts.some(
          (account) =>
            account.userId === userId &&
            account.toolkit === toolkit &&
            account.status === "ACTIVE",
        );
        if (held && !options.allowMultiple) {
          throw new ComposioMultipleConnectedAccountsError(
            `Multiple connected accounts found for user ${userId} in auth config ${authConfigId}. Please use the allowMultiple option to allow multiple connected accounts.`,
          );
        }
        asked.links.push({
          userId,
          allowMultiple: options.allowMultiple === true,
        });
        return {
          redirectUrl: `https://connect.composio.test/link/${userId}`,
        };
      },
      create: refuse("connectedAccounts.create"),
      delete: async (id) => {
        asked.deleted.push(id);
        const at = accounts.findIndex((account) => account.id === id);
        if (at >= 0) accounts.splice(at, 1);
        return { success: true };
      },
    },
  };
  const client = buildComposioClient(vendor);
  useComposioClient(client.actions);
  return { broker: client.broker, asked };
}

/** Two of Dana's Gmail accounts, work first, and one of somebody else's. */
function twoMailboxes(toolkit: string): HeldAccount[] {
  return [
    {
      id: "ca_dana_work",
      userId: PERSON,
      toolkit,
      email: WORK,
      createdAt: "2026-10-01T09:00:00.000Z",
      status: "ACTIVE",
    },
    {
      id: "ca_dana_home",
      userId: PERSON,
      toolkit,
      email: HOME,
      createdAt: "2026-10-20T09:00:00.000Z",
      status: "ACTIVE",
    },
    {
      id: "ca_someone_else",
      userId: OTHER,
      toolkit,
      email: THEIRS,
      createdAt: "2026-09-01T09:00:00.000Z",
      status: "ACTIVE",
    },
  ];
}

/** A Gmail app with one read action granted to the Bot, and the person's connection row. */
async function enableGmail(toolkit: string) {
  made.push(toolkit);
  await database.insert(mcpServers).values({
    id: toolkit,
    title: "Gmail",
    vendor: "Composio",
    url: `composio://${toolkit}`,
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  await database.insert(mcpTools).values({
    serverId: toolkit,
    name: "GMAIL_FETCH_EMAILS",
    vendorName: "GMAIL_FETCH_EMAILS",
    description: "Fetch emails.",
    effect: "read",
    version: "20260903_00",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  });
  await database
    .insert(agents)
    .values({ id: BOT, name: "Helper", type: "built_in", configuration: {} })
    .onConflictDoNothing();
  await database.insert(brokeredConnections).values({
    provider: "composio",
    app: toolkit,
    holder: "person",
    userId: PERSON,
    vendorUserId: PERSON,
    verified: true,
  });
}

function storeFor(
  broker: ReturnType<typeof composioHolding>["broker"],
  approvalGate?: ApprovalGate,
) {
  return createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
    ...(approvalGate ? { approvalGate } : {}),
  });
}

function routesAs(
  store: ReturnType<typeof storeFor>,
  broker: ReturnType<typeof composioHolding>["broker"],
  id: string,
) {
  const session: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id,
      email: `${id}@example.test`,
      role: "user",
    } as never);
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

type Listed = {
  accounts: {
    id: string;
    label: string;
    identity: string;
    isDefault: boolean;
  }[];
  canAddAnother: boolean;
};

async function listAccounts(
  app: ReturnType<typeof routesAs>,
  toolkit: string,
): Promise<Listed> {
  const response = await app.request(
    `/api/plugins/servers/${toolkit}/accounts`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Listed;
}

/** One Gmail read by the Bot for the person, with whatever arguments the model sent. */
async function fetchEmails(
  store: ReturnType<typeof storeFor>,
  toolkit: string,
  args: Record<string, unknown>,
) {
  await store.grant(
    "mcp",
    `${toolkit}/GMAIL_FETCH_EMAILS`,
    BOT,
    "admin@example.com",
  );
  return store.callTool({
    ref: `${toolkit}/GMAIL_FETCH_EMAILS`,
    args,
    botId: BOT,
    actorId: PERSON,
  });
}

afterEach(async () => {
  useComposioClient(null);
  if (made.length === 0) return;
  await database
    .delete(brokeredAccounts)
    .where(inArray(brokeredAccounts.app, made));
  await database
    .delete(brokeredConnections)
    .where(inArray(brokeredConnections.app, made));
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
  await database.delete(mcpServers).where(inArray(mcpServers.id, made));
  made.length = 0;
});

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.$client.end();
});

describe("a person with two Gmail accounts", () => {
  test("the app page lists both by the address Gmail reports, the first connected as the default", async () => {
    const toolkit = `gmail-${suite}-list`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);

    const listed = await listAccounts(
      routesAs(store, composio.broker, PERSON),
      toolkit,
    );

    expect(listed.canAddAnother).toBe(true);
    expect(
      listed.accounts.map(({ label, identity, isDefault }) => ({
        label,
        identity,
        isDefault,
      })),
    ).toEqual([
      { label: WORK, identity: WORK, isDefault: true },
      { label: HOME, identity: HOME, isDefault: false },
    ]);
    // Nobody else's mailbox, and no token, ever reaches the page.
    const body = JSON.stringify(listed);
    expect(body).not.toContain(THEIRS);
    expect(body).not.toContain("not-a-real");
    expect(body).not.toContain("ca_");
  });

  test("Connect over a standing connection asks for another account instead of refusing", async () => {
    const toolkit = `gmail-${suite}-another`;
    await enableGmail(toolkit);
    const composio = composioHolding(
      toolkit,
      twoMailboxes(toolkit).slice(0, 1),
    );
    const store = storeFor(composio.broker);

    const response = await routesAs(store, composio.broker, PERSON).request(
      `/api/plugins/servers/${toolkit}/connect`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authorizationUrl?: string;
      error?: string;
    };
    expect(body.error).toBeUndefined();
    expect(body.authorizationUrl).toStartWith(
      `https://connect.composio.test/link/${PERSON}`,
    );
    expect(composio.asked.links).toEqual([
      { userId: PERSON, allowMultiple: true },
    ]);
  });

  test("a call naming the second address runs in the second connected account", async () => {
    const toolkit = `gmail-${suite}-second`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);

    const result = await fetchEmails(store, toolkit, {
      account: HOME,
      query: "is:unread",
    });

    expect(result.isError).toBe(false);
    expect(composio.asked.executed).toEqual([
      { userId: PERSON, connectedAccountId: "ca_dana_home" },
    ]);
  });

  test("a call naming no account runs in the default, and in the new default once the person changes it", async () => {
    const toolkit = `gmail-${suite}-default`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    const app = routesAs(store, composio.broker, PERSON);
    const listed = await listAccounts(app, toolkit);

    await fetchEmails(store, toolkit, { query: "is:unread" });

    const home = listed.accounts.find((account) => account.label === HOME);
    const made = await app.request(
      `/api/plugins/servers/${toolkit}/accounts/${home?.id}/default`,
      { method: "POST" },
    );
    expect(made.status).toBe(200);
    await fetchEmails(store, toolkit, { query: "is:unread" });

    expect(composio.asked.executed).toEqual([
      { userId: PERSON, connectedAccountId: "ca_dana_work" },
      { userId: PERSON, connectedAccountId: "ca_dana_home" },
    ]);
  });

  test("an address the person does not hold, or somebody else's, is refused and nothing is sent", async () => {
    const toolkit = `gmail-${suite}-foreign`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);

    for (const named of [
      THEIRS,
      "nobody@nowhere.example",
      "ca_someone_else",
      42,
    ]) {
      const refused = fetchEmails(store, toolkit, { account: named });
      await expect(refused).rejects.toBeInstanceOf(PluginRefusedError);
      await expect(refused).rejects.toThrow(`Use one of: ${WORK}, ${HOME}.`);
    }
    expect(composio.asked.executed).toEqual([]);
  });

  test("the Bot is offered an account argument naming exactly the person's accounts", async () => {
    const toolkit = `gmail-${suite}-offered`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);
    await store.grant(
      "mcp",
      `${toolkit}/GMAIL_FETCH_EMAILS`,
      BOT,
      "admin@example.com",
    );

    const tools = await grantedTools({ store, botId: BOT, actorId: PERSON });
    const tool = tools.find(
      (candidate) => candidate.ref === `${toolkit}/GMAIL_FETCH_EMAILS`,
    );
    const parameters = tool?.parameters as z.ZodType;

    expect(parameters.safeParse({ account: HOME }).success).toBe(true);
    expect(parameters.safeParse({ account: WORK }).success).toBe(true);
    expect(parameters.safeParse({ account: THEIRS }).success).toBe(false);
    expect(parameters.safeParse({}).success).toBe(true);
  });

  test("disconnecting one account ends that account only, and the other keeps working", async () => {
    const toolkit = `gmail-${suite}-one`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    const app = routesAs(store, composio.broker, PERSON);
    const listed = await listAccounts(app, toolkit);
    const work = listed.accounts.find((account) => account.label === WORK);

    const response = await app.request(
      `/api/plugins/servers/${toolkit}/accounts/${work?.id}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(composio.asked.deleted).toEqual(["ca_dana_work"]);
    const after = await listAccounts(app, toolkit);
    expect(
      after.accounts.map(({ label, isDefault }) => ({ label, isDefault })),
    ).toEqual([{ label: HOME, isDefault: true }]);
    // The app is still connected for the person.
    expect(
      await database
        .select()
        .from(brokeredConnections)
        .where(
          and(
            eq(brokeredConnections.app, toolkit),
            eq(brokeredConnections.userId, PERSON),
          ),
        ),
    ).toHaveLength(1);
    await fetchEmails(store, toolkit, {});
    expect(composio.asked.executed).toEqual([
      { userId: PERSON, connectedAccountId: "ca_dana_home" },
    ]);
  });

  test("another person's account id is not one this person can disconnect or make default", async () => {
    const toolkit = `gmail-${suite}-not-yours`;
    await enableGmail(toolkit);
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: toolkit,
      holder: "person",
      userId: OTHER,
      vendorUserId: OTHER,
      verified: true,
    });
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const store = storeFor(composio.broker);
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);
    const theirs = await listAccounts(
      routesAs(store, composio.broker, OTHER),
      toolkit,
    );
    const id = theirs.accounts[0]?.id;

    const app = routesAs(store, composio.broker, PERSON);
    const ended = await app.request(
      `/api/plugins/servers/${toolkit}/accounts/${id}`,
      {
        method: "DELETE",
      },
    );
    const defaulted = await app.request(
      `/api/plugins/servers/${toolkit}/accounts/${id}/default`,
      { method: "POST" },
    );

    expect(ended.status).toBe(404);
    expect(defaulted.status).toBe(404);
    expect(composio.asked.deleted).toEqual([]);
  });
});

describe("asking the person first", () => {
  test("two otherwise identical calls to different accounts reach the approval step as different requests, each naming its account", async () => {
    const toolkit = `gmail-${suite}-approval`;
    await enableGmail(toolkit);
    const composio = composioHolding(toolkit, twoMailboxes(toolkit));
    const asked: ApprovalCandidate[] = [];
    const store = storeFor(composio.broker, async (candidate) => {
      asked.push(candidate);
      return undefined;
    });
    await listAccounts(routesAs(store, composio.broker, PERSON), toolkit);

    await fetchEmails(store, toolkit, { account: WORK, query: "is:unread" });
    await fetchEmails(store, toolkit, { account: HOME, query: "is:unread" });

    expect(asked.map((candidate) => candidate.account)).toEqual([WORK, HOME]);
    // The account is not one of the action's own arguments, and it is part of the comparison.
    expect(asked[0]?.args).toEqual(asked[1]?.args);
    const [work, home] = asked;
    if (!work || !home) throw new Error("the approval step was not asked");
    expect(equivalenceOf(work)).not.toBe(equivalenceOf(home));
  });
});

describe("a connection made before accounts were listed", () => {
  test("calls exactly as it did: as the person, naming no account", async () => {
    const toolkit = `gmail-${suite}-legacy`;
    await enableGmail(toolkit);
    const composio = composioHolding(
      toolkit,
      twoMailboxes(toolkit).slice(0, 1),
    );
    const store = storeFor(composio.broker);

    const result = await fetchEmails(store, toolkit, { query: "is:unread" });

    expect(result.isError).toBe(false);
    expect(composio.asked.executed).toEqual([{ userId: PERSON }]);
    expect(
      await database
        .select()
        .from(brokeredAccounts)
        .where(eq(brokeredAccounts.app, toolkit)),
    ).toEqual([]);
  });
});
