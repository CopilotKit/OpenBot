// server/tests/composio-single-user-identity.integration.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ComposioMultipleConnectedAccountsError,
  ToolSchema,
} from "@composio/core";
import { Hono } from "hono";
import postgres from "postgres";
import { createAuditStore } from "../src/audit";
import {
  createDevRequireUser,
  DEV_ACTOR,
  initializeDevActorUser,
} from "../src/auth/dev-actor";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import {
  agents,
  brokeredConnections,
  brokeredIdentities,
  mcpServers,
  mcpTools,
} from "../src/db/schema";
import { useComposioClient } from "../src/plugins/composio";
import {
  buildComposioClient,
  type ComposioVendor,
} from "../src/plugins/composio-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import { ensureSingleUserIdentity } from "../src/plugins/single-user-identity";
import { createPluginStore } from "../src/plugins/store";
import fixture from "./fixtures/composio-file-actions.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * EVERY SINGLE-USER OPENBOT ON ONE COMPOSIO KEY WAS ONE COMPOSIO USER.
 *
 * WHAT WAS SEEN. A single-user deployment's one person is `dev-local-user`, and that id was what
 * Composio filed their accounts under. A test OpenBot on one machine listed another local stack's
 * active Gmail connection as its own. The same sharing meant a disconnect in one ended the other's
 * account, and a call that names no account could run in whichever of them connected last.
 *
 * WHAT IS ASSERTED. Two single-user deployments, each with its own database, on one Composio key:
 * each has its own name at Composio, a Gmail connected in one is not listed, adoptable or callable
 * in the other, and a disconnect in one leaves the other's account alone. A deployment that already
 * holds accounts under `dev-local-user` keeps that name, and the name is the same after a restart
 * and on every replica.
 *
 * REAL DATABASES, REAL ROUTES, THE REAL SINGLE-USER GUARD, THE REAL STORE AND THE REAL COMPOSIO
 * ADAPTER. Each deployment is a database created here and migrated with this repository's own
 * migrations, because the property is about two databases and a schema inside one would share the
 * very rows that tell deployments apart. Only Composio is a double, at the vendor client: its
 * `link` refuses exactly as `@composio/core` 0.18.1 does (the double in
 * `composio-connect-adopts-held-account.test.ts`, which this one follows), its listings honour the
 * query they are given, and the action resolves from the rows Composio published
 * (`fixtures/composio-file-actions.json`), as in `composio-file-parameters.test.ts`.
 */

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");

const created: string[] = [];
const opened: Database[] = [];

const BOT = "helper";
const ACTION = "GMAIL_FETCH_EMAILS";
const REF = `gmail/${ACTION}`;

/** A database of its own, migrated as a deployment's would be, and dropped after the file. */
async function freshDatabase(): Promise<string> {
  const name = `openbot_identity_${suite}_${created.length}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(client, migrations);
  } finally {
    await client.end({ timeout: 5 });
  }
  return url.href;
}

function open(url: string): Database {
  const database = createDatabase(url, TEST_POOL);
  opened.push(database);
  return database;
}

async function close(database: Database) {
  opened.splice(opened.indexOf(database), 1);
  await database.$client.close();
}

afterAll(async () => {
  useComposioClient(null);
  for (const database of opened) await database.$client.close();
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

/** The vendor's account statuses, spelled here because the adapter keeps its copy private. */
type AccountStatus =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

/** An account as Composio holds it, with the mailbox behind it. */
type HeldAccount = {
  id: string;
  userId: string;
  toolkit: string;
  config: string;
  status: AccountStatus;
  mailbox: string;
};

/** One row as the listing hands it over: the wire's own snake_case, nothing parsed. */
type WireRow = {
  slug: string;
  version: string;
  input_parameters: Record<string, unknown>;
  available_versions?: string[];
  deprecated?: { is_deprecated?: boolean };
  no_auth?: boolean;
  [key: string]: unknown;
};

const published = (fixture as unknown as Record<"gmail", WireRow[]>).gmail;
const fetchEmails = published.find((row) => row.slug === ACTION) as WireRow;

const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};

/**
 * One Composio project, as the one API key every deployment here shares sees it: one auth config
 * for Gmail (ours), the accounts it holds, every link it minted and every action it ran.
 */
function composioProject() {
  const config = { id: "ac_gmail", name: "gmail (OpenBot)", status: "ENABLED" };
  const accounts: HeldAccount[] = [];
  const minted: string[] = [];
  const ran: { userId: string; mailbox: string }[] = [];

  const vendor: ComposioVendor = {
    tools: {
      list: refuse("tools.list"),
      // What `Tools.transformToolCases` builds before the SDK hands a resolved tool back.
      getRawComposioToolBySlug: async (slug, options) => {
        if (slug !== ACTION || options?.version !== fetchEmails.version) {
          throw new Error(`${slug} is not in this fixture.`);
        }
        return ToolSchema.parse({
          ...structuredClone(fetchEmails),
          inputParameters: structuredClone(fetchEmails.input_parameters),
          availableVersions: fetchEmails.available_versions,
          isDeprecated: fetchEmails.deprecated?.is_deprecated ?? false,
          isNoAuth: fetchEmails.no_auth,
        });
      },
      /*
       * Runs in an ACTIVE account of the user the call names, and in no one else's. Which of a
       * user's several accounts Composio picks for a call that names none is not documented for a
       * direct execute, so this double holds at most one per user when a call is unpinned and says
       * so rather than guessing.
       */
      execute: async (slug, body) => {
        const theirs = accounts.filter(
          (account) =>
            account.userId === body.userId &&
            account.toolkit === "gmail" &&
            account.status === "ACTIVE",
        );
        const account =
          body.connectedAccountId === undefined
            ? theirs.length === 1
              ? theirs[0]
              : undefined
            : theirs.find((held) => held.id === body.connectedAccountId);
        if (!account) {
          throw new Error(
            `${slug} named ${body.userId}, who holds ${theirs.length} ACTIVE Gmail accounts; this double answers only for exactly one.`,
          );
        }
        ran.push({ userId: body.userId, mailbox: account.mailbox });
        return {
          data: {
            messages: [
              {
                messageId: `msg_${account.id}`,
                to: account.mailbox,
                subject: "Quarterly numbers",
              },
            ],
          },
          error: null,
          successful: true,
        };
      },
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: async (query) => ({
        items: query.toolkit === "gmail" ? [config] : [],
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
                query.authConfigIds.includes(account.config)),
          )
          .map((account) => ({
            id: account.id,
            status: account.status,
            authConfig: { id: account.config },
            toolkit: { slug: account.toolkit },
          })),
        nextCursor: null,
      }),
      /*
       * `@composio/core` 0.18.1, `ConnectedAccounts.link`: an ACTIVE account for this user on this
       * auth config refuses a second link with the SDK's own error and message; this deployment
       * never sends `allowMultiple`.
       */
      link: async (userId, authConfigId, linkOptions) => {
        const existing = accounts.filter(
          (account) =>
            account.userId === userId &&
            account.config === authConfigId &&
            account.status === "ACTIVE",
        );
        if (existing.length > 0) {
          throw new ComposioMultipleConnectedAccountsError(
            `Multiple connected accounts found for user ${userId} in auth config ${authConfigId}. Please use the allowMultiple option to allow multiple connected accounts.`,
          );
        }
        minted.push(userId);
        return {
          redirectUrl: `https://connect.composio.test/link/${userId}?back=${encodeURIComponent(linkOptions.callbackUrl)}`,
        };
      },
      create: refuse("connectedAccounts.create"),
      delete: async (id) => {
        const at = accounts.findIndex((account) => account.id === id);
        if (at < 0) throw new Error(`No connected account ${id}.`);
        accounts.splice(at, 1);
        return { success: true };
      },
    },
  };

  const client = buildComposioClient(vendor);
  return {
    client,
    accounts,
    minted,
    ran,
    /** The person finishing Google's consent for `userId`: Composio now holds the account. */
    consented(userId: string, mailbox: string) {
      accounts.push({
        id: `ca_${accounts.length + 1}`,
        userId,
        toolkit: "gmail",
        config: config.id,
        status: "ACTIVE",
        mailbox,
      });
    },
  };
}

type Project = ReturnType<typeof composioProject>;

/** Composio as `index.ts` hands it over: the provider, and what its adapter declares. */
const composioWired = (project: Project) => ({
  provider: "composio" as const,
  grantIsLocal: project.client.broker.grantIsLocal,
});

/**
 * A single-user deployment starting: its one person written, its Composio name settled, and its
 * store and routes built over its own database, behind the real single-user guard.
 */
async function boot(url: string, project: Project) {
  const database = open(url);
  await initializeDevActorUser(database, true);
  const identity = await ensureSingleUserIdentity(database, {
    singleUser: true,
    broker: composioWired(project),
  });
  if (identity === null) {
    throw new Error("A single-user deployment on Composio was given no name.");
  }
  const store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker: project.client.broker,
    deploymentId: "single-user",
  });
  const app = new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      createDevRequireUser(),
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker: project.client.broker, provider: "composio" },
    ),
  );
  /** What a Bot granted Gmail reads when it fetches mail for the person. */
  const readMail = () =>
    store.callTool({
      ref: REF,
      args: {},
      botId: BOT,
      actorId: DEV_ACTOR.id,
    });
  return { database, identity, store, app, readMail };
}

type Deployment = Awaited<ReturnType<typeof boot>>;

/** Gmail enabled as a Personal app with one action, and a Bot granted it. */
async function enableGmail({ database, store }: Deployment) {
  await database.insert(mcpServers).values({
    id: "gmail",
    title: "Gmail",
    vendor: "Composio",
    url: "composio://gmail",
    provenance: "composio",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
  await database.insert(mcpTools).values({
    serverId: "gmail",
    name: ACTION,
    vendorName: ACTION,
    description: "Fetch emails.",
    effect: "read",
    version: fetchEmails.version,
  });
  await database
    .insert(agents)
    .values({ id: BOT, name: "Helper", type: "built_in", configuration: {} });
  await store.grant("mcp", REF, BOT, DEV_ACTOR.email);
}

/** A deployment that has never connected anything, up and with Gmail enabled. */
async function newDeployment(project: Project) {
  const deployment = await boot(await freshDatabase(), project);
  await enableGmail(deployment);
  return deployment;
}

const pressConnect = (deployment: Deployment) =>
  deployment.app.request("/api/plugins/servers/gmail/connect", {
    method: "POST",
  });

const confirm = async (deployment: Deployment) =>
  (await (
    await deployment.app.request(
      "/api/plugins/servers/gmail/connection/confirm",
      {
        method: "POST",
      },
    )
  ).json()) as { connected?: boolean; error?: string };

/** Connect pressed, consent finished at Composio as `mailbox`, and the page confirming on load. */
async function connectGmail(
  deployment: Deployment,
  project: Project,
  mailbox: string,
) {
  const response = await pressConnect(deployment);
  expect(response.status).toBe(200);
  const { authorizationUrl } = (await response.json()) as {
    authorizationUrl?: string;
  };
  // The consent link is minted under this deployment's own name, never under somebody else's.
  expect(authorizationUrl).toStartWith(
    `https://connect.composio.test/link/${deployment.identity}?`,
  );
  project.consented(deployment.identity, mailbox);
  expect(await confirm(deployment)).toEqual({ connected: true });
}

const listed = async (deployment: Deployment) =>
  (
    (await (
      await deployment.app.request("/api/plugins/connections")
    ).json()) as {
      connections: { serverId: string }[];
    }
  ).connections.map((connection) => connection.serverId);

const rowsIn = (database: Database) =>
  database
    .select({
      userId: brokeredConnections.userId,
      vendorUserId: brokeredConnections.vendorUserId,
    })
    .from(brokeredConnections);

describe("two single-user deployments on one Composio key", () => {
  test("each is its own Composio user, and one's Gmail is not listed, adopted or called in the other", async () => {
    const project = composioProject();
    useComposioClient(project.client.actions);
    const a = await newDeployment(project);
    const b = await newDeployment(project);

    // Same person here, two names at Composio.
    expect(a.identity).toStartWith(`${DEV_ACTOR.id}:`);
    expect(b.identity).toStartWith(`${DEV_ACTOR.id}:`);
    expect(a.identity).not.toBe(b.identity);

    await connectGmail(a, project, "a@example.test");
    expect(await rowsIn(a.database)).toEqual([
      { userId: DEV_ACTOR.id, vendorUserId: a.identity },
    ]);

    // B's page does not list A's Gmail, and asking Composio from B finds nothing of A's.
    expect(await listed(b)).not.toContain("gmail");
    expect(await confirm(b)).toEqual({ connected: false });
    expect(await rowsIn(b.database)).toEqual([]);

    // A Bot on B cannot read A's mail: it is told to connect, and nothing runs at Composio.
    await expect(b.readMail()).rejects.toThrow(
      "You have not connected your Gmail account.",
    );
    expect(project.ran).toEqual([]);

    // Connect on B mints B's own consent rather than adopting the account A connected.
    const pressed = await pressConnect(b);
    expect(pressed.status).toBe(200);
    expect(
      ((await pressed.json()) as { authorizationUrl?: string })
        .authorizationUrl,
    ).toStartWith(`https://connect.composio.test/link/${b.identity}?`);
    expect(project.minted).toEqual([a.identity, b.identity]);
    expect(await rowsIn(b.database)).toEqual([]);

    // A's Bot reads A's mail.
    const read = await a.readMail();
    expect(read.isError).toBe(false);
    expect(read.text).toContain("a@example.test");
    expect(project.ran).toEqual([
      { userId: a.identity, mailbox: "a@example.test" },
    ]);
  });

  test("a second Gmail connected in one leaves the other's mail where it was, and so does its disconnect", async () => {
    const project = composioProject();
    useComposioClient(project.client.actions);
    const a = await newDeployment(project);
    const b = await newDeployment(project);

    await connectGmail(a, project, "a@example.test");
    await connectGmail(b, project, "b@example.test");

    // Each Bot reads its own deployment's mailbox, whichever was connected last.
    expect((await a.readMail()).text).toContain("a@example.test");
    expect((await b.readMail()).text).toContain("b@example.test");
    expect(project.ran).toEqual([
      { userId: a.identity, mailbox: "a@example.test" },
      { userId: b.identity, mailbox: "b@example.test" },
    ]);

    // B disconnects. Composio ends B's account and only B's.
    const ended = await b.app.request("/api/plugins/servers/gmail/connection", {
      method: "DELETE",
    });
    expect(ended.status).toBe(200);
    expect(project.accounts.map((account) => account.mailbox)).toEqual([
      "a@example.test",
    ]);
    expect(await rowsIn(b.database)).toEqual([]);

    // A is still connected, and its Bot still reads its mail.
    expect(await confirm(a)).toEqual({ connected: true });
    expect((await a.readMail()).text).toContain("a@example.test");
  });
});

describe("a single-user deployment that already holds Composio accounts under dev-local-user", () => {
  /** Gmail connected the way every single-user OpenBot connected it before its own name existed. */
  async function connectedBeforeTheUpgrade(project: Project) {
    const url = await freshDatabase();
    const before = open(url);
    await before.insert(brokeredConnections).values({
      provider: "composio",
      app: "gmail",
      holder: "person",
      userId: DEV_ACTOR.id,
      vendorUserId: DEV_ACTOR.id,
      verified: true,
      verifiedAt: new Date(),
    });
    await close(before);
    project.consented(DEV_ACTOR.id, "me@example.test");
    return url;
  }

  test("keeps that name, so its Gmail stays connected and nobody reconnects", async () => {
    const project = composioProject();
    useComposioClient(project.client.actions);
    const deployment = await boot(
      await connectedBeforeTheUpgrade(project),
      project,
    );
    await enableGmail(deployment);

    expect(deployment.identity).toBe(DEV_ACTOR.id);
    expect(await deployment.database.select().from(brokeredIdentities)).toEqual(
      [],
    );
    expect(await listed(deployment)).toContain("gmail");
    expect(await confirm(deployment)).toEqual({ connected: true });
    expect((await deployment.readMail()).text).toContain("me@example.test");
    expect(project.ran).toEqual([
      { userId: DEV_ACTOR.id, mailbox: "me@example.test" },
    ]);
  });

  test("gets its own name at the first start after its last such account is disconnected", async () => {
    const project = composioProject();
    useComposioClient(project.client.actions);
    const url = await connectedBeforeTheUpgrade(project);
    const before = await boot(url, project);
    await enableGmail(before);
    expect(before.identity).toBe(DEV_ACTOR.id);

    const ended = await before.app.request(
      "/api/plugins/servers/gmail/connection",
      { method: "DELETE" },
    );
    expect(ended.status).toBe(200);
    expect(project.accounts).toEqual([]);
    await close(before.database);

    const after = await boot(url, project);
    expect(after.identity).toStartWith(`${DEV_ACTOR.id}:`);
    await connectGmail(after, project, "me@example.test");
    expect(await rowsIn(after.database)).toEqual([
      { userId: DEV_ACTOR.id, vendorUserId: after.identity },
    ]);
  });
});

describe("a single-user deployment's Composio name", () => {
  test("is the same after a restart, and the Gmail connected under it is still connected", async () => {
    const project = composioProject();
    useComposioClient(project.client.actions);
    const url = await freshDatabase();
    const first = await boot(url, project);
    await enableGmail(first);
    await connectGmail(first, project, "me@example.test");
    await close(first.database);

    const restarted = await boot(url, project);
    expect(restarted.identity).toBe(first.identity);
    expect(await confirm(restarted)).toEqual({ connected: true });
    expect((await restarted.readMail()).text).toContain("me@example.test");
    expect(project.ran).toEqual([
      { userId: first.identity, mailbox: "me@example.test" },
    ]);
  });

  test("is one name when two replicas start together", async () => {
    const url = await freshDatabase();
    const [one, two] = [open(url), open(url)];
    const broker = composioWired(composioProject());
    const settled = await Promise.all([
      ensureSingleUserIdentity(one, { singleUser: true, broker }, () => "one"),
      ensureSingleUserIdentity(two, { singleUser: true, broker }, () => "two"),
    ]);
    expect(settled[0]).toBe(settled[1] as string);
    expect([`${DEV_ACTOR.id}:one`, `${DEV_ACTOR.id}:two`]).toContain(
      settled[0] as string,
    );
    expect(await one.select().from(brokeredIdentities)).toHaveLength(1);
  });

  test("is not given to a deployment that signs people in, or has no broker", async () => {
    const database = open(await freshDatabase());
    expect(
      await ensureSingleUserIdentity(database, {
        singleUser: false,
        broker: composioWired(composioProject()),
      }),
    ).toBeNull();
    expect(
      await ensureSingleUserIdentity(database, {
        singleUser: true,
        broker: null,
      }),
    ).toBeNull();
    expect(await database.select().from(brokeredIdentities)).toEqual([]);
  });
});
