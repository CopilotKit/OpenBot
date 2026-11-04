// server/tests/composio-single-user-identity.integration.test.ts
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import { createCredentialStore } from "../src/credentials";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import { mcpTools } from "../src/db/schema";
import { useComposioClient } from "../src/plugins/composio";
import {
  buildComposioClient,
  type ComposioVendor,
} from "../src/plugins/composio-adapter";
import { createPluginRoutes } from "../src/plugins/routes";
import { ensureSingleUserIdentity } from "../src/plugins/single-user-identity";
import { createPluginStore } from "../src/plugins/store";
import type { BrokeredConnection, BrokeredIdentity } from "../src/vault/client";
import {
  type ConnectionsDirectory,
  installConnectionsDirectory,
} from "../src/vault/directory";
import { brokeredId } from "../src/vault/ids";
import fixture from "./fixtures/composio-file-actions.json";
import {
  removeBots,
  seedBot,
  type TestIntelligence,
  testIntelligence,
} from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  deploymentDirectory,
  secondTestProject,
  useTestVault,
} from "./support/vault";

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
 * holds accounts under `dev-local-user` gets its own name too, with its records under the shared
 * name retired here and nothing at Composio touched, and the name is the same after a restart and
 * on every replica.
 *
 * REAL DATABASES, REAL PROJECTS, REAL ROUTES, THE REAL SINGLE-USER GUARD, THE REAL STORE AND THE
 * REAL COMPOSIO ADAPTER. Each deployment is a database created here and migrated with this
 * repository's own migrations, and an Intelligence project of its own: a deployment's apps, its
 * accounts and its name at Composio are its project's (Intelligence's connections), so two
 * deployments are two databases on two projects, and one sharing a project with another would share
 * the very records that tell deployments apart. Only Composio is a double, at the vendor client: its
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

/*
 * One Bot for every deployment this file boots. Each deployment has a database of its own, but Bots
 * live in Intelligence, and the tests share one project there: so the Bot is made once, under an id
 * no other file or run uses, and every deployment grants to it.
 */
const BOT = `helper-${suite}`;
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

/**
 * A deployment's own place: a fresh database, and an Intelligence project holding none of what this
 * file writes there. The first deployment a test makes is on the test project, the second on the
 * second project (`TEST_INTELLIGENCE_API_KEY_2`); no test here runs three side by side.
 */
type Install = { url: string; project: TestIntelligence };

let installsThisTest = 0;
const inspectors = new Map<string, ConnectionsDirectory>();
const usedProjects = new Map<string, TestIntelligence>();
/** Every deployment directory started in this test, stopped when it ends. */
const running: ConnectionsDirectory[] = [];

/** A directory that only reads and clears a project for this file: never a deployment's own. */
async function inspector(project: TestIntelligence) {
  let held = inspectors.get(project.apiKey);
  if (!held) {
    usedProjects.set(project.apiKey, project);
    held = await deploymentDirectory(project);
    inspectors.set(project.apiKey, held);
  }
  return held;
}

/** Every record this file writes in a project: the person's Gmail accounts, their name at Composio, and Gmail. */
async function clearProject(project: TestIntelligence) {
  const directory = await inspector(project);
  const { connections } = await directory.client.connections.all();
  for (const connection of connections) {
    if (connection.kind === "grant") continue;
    if (
      connection.provider === "composio" &&
      connection.userId === DEV_ACTOR.id &&
      (connection.kind === "identity" || connection.app === "gmail")
    )
      await directory.removeConnection(connection.id);
  }
  if (await directory.client.toolServers.get("gmail"))
    await directory.removeServer("gmail");
}

async function freshInstall(): Promise<Install> {
  installsThisTest += 1;
  if (installsThisTest > 2)
    throw new Error("This file runs at most two deployments in one test.");
  const project =
    installsThisTest === 1 ? testIntelligence() : secondTestProject();
  await clearProject(project);
  return { url: await freshDatabase(), project };
}

/** The Composio Gmail accounts a project holds now for the single-user person, from Intelligence. */
async function accountsIn(project: TestIntelligence) {
  const { connections } = await (
    await inspector(project)
  ).client.connections.all();
  return connections.filter(
    (connection): connection is BrokeredConnection =>
      connection.kind === "brokered" &&
      connection.provider === "composio" &&
      connection.app === "gmail",
  );
}

/** The person's names at Composio a project holds now, from Intelligence. */
async function namesIn(project: TestIntelligence) {
  const { connections } = await (
    await inspector(project)
  ).client.connections.all();
  return connections
    .filter(
      (connection): connection is BrokeredIdentity =>
        connection.kind === "identity" &&
        connection.provider === "composio" &&
        connection.userId === DEV_ACTOR.id,
    )
    .map((connection) => ({ vendorUserId: connection.vendorUserId }));
}

/*
 * Each test's databases are closed when it ends, so their pools do not pile up across the file.
 * Two connections a deployment, held to the end, ran a full CI run's Postgres out of clients.
 */
beforeAll(async () => {
  await seedBot({ id: BOT, name: "Helper", type: "built_in" });
});

beforeEach(() => {
  installsThisTest = 0;
});

afterEach(async () => {
  for (const directory of running.splice(0)) directory.stop();
  for (const database of opened.splice(0)) await database.$client.close();
  // The process's own vault back, for whatever runs after this file in the same process.
  installConnectionsDirectory(await useTestVault());
});

// Every database this file created is dropped here, and there are a few dozen of them.
afterAll(async () => {
  await removeBots([BOT]);
  for (const project of usedProjects.values()) await clearProject(project);
  for (const directory of inspectors.values()) directory.stop();
  installConnectionsDirectory(await useTestVault());
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
}, 60_000);

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

/**
 * A single-user deployment starting: its one person written, its Composio name settled, and its
 * store and routes built over its own database, behind the real single-user guard.
 */
async function boot(
  install: Install,
  project: Project,
  /** False for a deployment as it ran before it could be given a name of its own. */
  { named = true }: { named?: boolean } = {},
) {
  const database = open(install.url);
  /*
   * THIS DEPLOYMENT'S PROCESS. Its apps, accounts and name are read through the one directory a
   * server installs, so it is installed whenever this deployment acts: every request, call and store
   * method below goes through `acting`, and the tests drive one deployment at a time.
   */
  const directory = await deploymentDirectory(install.project, database);
  running.push(directory);
  const acting = <T>(work: () => T): T => {
    installConnectionsDirectory(directory);
    return work();
  };
  await initializeDevActorUser(database, true);
  const identity = named
    ? await acting(() =>
        ensureSingleUserIdentity({
          singleUser: true,
          provider: "composio",
        }),
      )
    : DEV_ACTOR.id;
  if (identity === null) {
    throw new Error("A single-user deployment on Composio was given no name.");
  }
  const store = createPluginStore({
    brokerProvider: "composio",
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(directory),
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker: project.client.broker,
    deploymentId: "single-user",
  });
  const routes = new Hono().route(
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
  const app = {
    request: async (path: string, init?: RequestInit) =>
      acting(() => routes.request(path, init)),
  };
  /** What a Bot granted Gmail reads when it fetches mail for the person. */
  const readMail = () =>
    acting(() =>
      store.callTool({
        ref: REF,
        args: {},
        botId: BOT,
        actorId: DEV_ACTOR.id,
      }),
    );
  /** The server stopping: its database and its directory let go. */
  const stop = async () => {
    directory.stop();
    await close(database);
  };
  return {
    database,
    directory,
    install,
    identity,
    store,
    app,
    readMail,
    acting,
    stop,
  };
}

type Deployment = Awaited<ReturnType<typeof boot>>;

/** Gmail enabled as a Personal app with one action, and a Bot granted it. */
async function enableGmail({ database, directory, store, acting }: Deployment) {
  await directory.createServer({
    id: "gmail",
    title: "Gmail",
    logo: null,
    vendor: "Composio",
    url: "composio://gmail",
    provenance: "composio",
    authScheme: "OAUTH2",
    credentialId: null,
    accountMode: "personal",
    sharedVendorUserId: null,
    ownerGrants: null,
    entraScope: null,
    addedBy: null,
  });
  await database.insert(mcpTools).values({
    serverId: "gmail",
    name: ACTION,
    vendorName: ACTION,
    description: "Fetch emails.",
    effect: "read",
    version: fetchEmails.version,
  });
  await acting(() => store.grant("mcp", REF, BOT, DEV_ACTOR.email));
}

/** A deployment that has never connected anything, up and with Gmail enabled. */
async function newDeployment(project: Project) {
  const deployment = await boot(await freshInstall(), project);
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

/** The Gmail accounts this deployment holds, as its project in Intelligence holds them now. */
const rowsIn = async (deployment: Deployment) =>
  (await accountsIn(deployment.install.project)).map((connection) => ({
    userId: connection.userId,
    vendorUserId: connection.vendorUserId,
  }));

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
    expect(await rowsIn(a)).toEqual([
      { userId: DEV_ACTOR.id, vendorUserId: a.identity },
    ]);

    // B's page does not list A's Gmail, and asking Composio from B finds nothing of A's.
    expect(await listed(b)).not.toContain("gmail");
    expect(await confirm(b)).toEqual({ connected: false });
    expect(await rowsIn(b)).toEqual([]);

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
    expect(await rowsIn(b)).toEqual([]);

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
    expect(await rowsIn(b)).toEqual([]);

    // A is still connected, and its Bot still reads its mail.
    expect(await confirm(a)).toEqual({ connected: true });
    expect((await a.readMail()).text).toContain("a@example.test");
  });
});

describe("a single-user deployment that already holds Composio accounts under dev-local-user", () => {
  /** Gmail connected the way every single-user OpenBot connected it before its own name existed. */
  async function connectedBeforeTheUpgrade(project: Project) {
    const install = await freshInstall();
    await (await inspector(install.project)).createConnection({
      kind: "brokered",
      id: brokeredId("composio", "gmail", "person", DEV_ACTOR.id),
      provider: "composio",
      app: "gmail",
      holder: "person",
      userId: DEV_ACTOR.id,
      vendorUserId: DEV_ACTOR.id,
      connectedBy: null,
      verified: true,
      verifiedAt: new Date(),
      probeAction: null,
    });
    project.consented(DEV_ACTOR.id, "me@example.test");
    return install;
  }

  test("gets its own name at once, stops using the shared account without ending it, and one Connect puts Gmail back", async () => {
    const project = composioProject();
    useComposioClient(project.client.actions);
    const install = await connectedBeforeTheUpgrade(project);
    const shared = structuredClone(project.accounts);
    const deployment = await boot(install, project);
    await enableGmail(deployment);

    // Its own name, written down, at the first start.
    expect(deployment.identity).toStartWith(`${DEV_ACTOR.id}:`);
    expect(await namesIn(install.project)).toEqual([
      { vendorUserId: deployment.identity },
    ]);

    // The record under the shared name is retired here: Gmail reads as not connected, a Bot is told
    // to connect it, and nothing runs at Composio as `dev-local-user`.
    expect(await rowsIn(deployment)).toEqual([]);
    expect(await listed(deployment)).not.toContain("gmail");
    await expect(deployment.readMail()).rejects.toThrow(
      "You have not connected your Gmail account.",
    );
    expect(await confirm(deployment)).toEqual({ connected: false });
    expect(project.ran).toEqual([]);
    // And the account Composio holds under the shared name is left exactly as it was.
    expect(project.accounts).toEqual(shared);

    // One Connect files Gmail under the deployment's own name.
    await connectGmail(deployment, project, "me@example.test");
    expect(await rowsIn(deployment)).toEqual([
      { userId: DEV_ACTOR.id, vendorUserId: deployment.identity },
    ]);
    expect((await deployment.readMail()).text).toContain("me@example.test");
    expect(project.ran).toEqual([
      { userId: deployment.identity, mailbox: "me@example.test" },
    ]);
  });

  test("whose record was another deployment's account can no longer use, list or end it", async () => {
    /*
     * BEFORE THE UPGRADE, A AND B ON ONE KEY WERE ONE COMPOSIO USER. A connected Gmail; B opened
     * the app's page, and the confirm there found A's account under `dev-local-user` and recorded
     * it as B's own. That record is the one an earlier revision of this change read as "B already
     * holds accounts", and kept B on the shared name with A's mailbox for good.
     */
    const project = composioProject();
    useComposioClient(project.client.actions);
    const a = await boot(await freshInstall(), project, { named: false });
    await enableGmail(a);
    await connectGmail(a, project, "a@example.test");
    const installB = await freshInstall();
    const b = await boot(installB, project, { named: false });
    await enableGmail(b);
    expect(await confirm(b)).toEqual({ connected: true });
    expect((await b.readMail()).text).toContain("a@example.test");
    const aAccount = structuredClone(project.accounts);
    project.ran.splice(0);
    await b.stop();

    // B upgrades. A has not, and still uses `dev-local-user`.
    const upgraded = await boot(installB, project);
    expect(upgraded.identity).toStartWith(`${DEV_ACTOR.id}:`);

    // B no longer lists, confirms or calls A's Gmail.
    expect(await listed(upgraded)).not.toContain("gmail");
    expect(await confirm(upgraded)).toEqual({ connected: false });
    await expect(upgraded.readMail()).rejects.toThrow(
      "You have not connected your Gmail account.",
    );
    expect(project.ran).toEqual([]);

    // B's Disconnect asks about B's own name only, so A's account stands.
    const ended = await upgraded.app.request(
      "/api/plugins/servers/gmail/connection",
      { method: "DELETE" },
    );
    expect(ended.status).toBe(200);
    expect(project.accounts).toEqual(aAccount);

    // And A, still on the shared name, still reads its own mail.
    expect((await a.readMail()).text).toContain("a@example.test");
  });
});

describe("a single-user deployment's Composio name", () => {
  test("is the same after a restart, and the Gmail connected under it is still connected", async () => {
    const project = composioProject();
    useComposioClient(project.client.actions);
    const install = await freshInstall();
    const first = await boot(install, project);
    await enableGmail(first);
    await connectGmail(first, project, "me@example.test");
    await first.stop();

    const restarted = await boot(install, project);
    expect(restarted.identity).toBe(first.identity);
    expect(await confirm(restarted)).toEqual({ connected: true });
    expect((await restarted.readMail()).text).toContain("me@example.test");
    expect(project.ran).toEqual([
      { userId: first.identity, mailbox: "me@example.test" },
    ]);
  });

  test("is one name when two replicas start together", async () => {
    const install = await freshInstall();
    const provider = "composio" as const;
    /*
     * Both starts race at Intelligence, which holds one name per person and broker under one id:
     * each misses, each files its own name, and the one filed second is refused and reads back the
     * first. The two run in this one process through one directory, because a process has one
     * installed; what decides the race is Intelligence's rule, not either process's memory.
     */
    installConnectionsDirectory(await inspector(install.project));
    const settled = await Promise.all([
      ensureSingleUserIdentity({ singleUser: true, provider }, () => "one"),
      ensureSingleUserIdentity({ singleUser: true, provider }, () => "two"),
    ]);
    expect(settled[0]).toBe(settled[1] as string);
    expect([`${DEV_ACTOR.id}:one`, `${DEV_ACTOR.id}:two`]).toContain(
      settled[0] as string,
    );
    expect(await namesIn(install.project)).toHaveLength(1);
  });

  test("is not given to a deployment that signs people in, or has no broker", async () => {
    const install = await freshInstall();
    installConnectionsDirectory(await inspector(install.project));
    expect(
      await ensureSingleUserIdentity({
        singleUser: false,
        provider: "composio",
      }),
    ).toBeNull();
    expect(
      await ensureSingleUserIdentity({
        singleUser: true,
        provider: null,
      }),
    ).toBeNull();
    expect(await namesIn(install.project)).toEqual([]);
  });
});
