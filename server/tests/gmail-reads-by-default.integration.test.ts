import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fitToolLimit } from "../src/agents/tool-search";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { mcpServers, mcpTools, pluginGrants } from "../src/db/schema/plugins";
import { setEdition } from "../src/edition";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { useComposioClient } from "../src/plugins/composio";
import { actionOf, type VendorToolRow } from "../src/plugins/composio-vendor";
import {
  personalDefaultsDeps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import captured from "./fixtures/composio-gmail-catalogue.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Gmail connected in OpenBot Personal: every Bot holds every action, and can read its mail.
 *
 * FOUND IN 1.0.0. The personal starter Bot, on an endpoint, told the person it could not read the
 * subjects or bodies of their mail: its Gmail was "get profile, send email, and POP settings", with no
 * tool that fetches a message, and "an administrator" had to add one. It held all of Gmail's actions.
 * What it was SENT was eleven of them, chosen for one run by word overlap with the message.
 *
 * Driven through the real store against a real database, with Composio's own Gmail catalogue
 * (`fixtures/composio-gmail-catalogue.json`) answering the listing the way Composio does: the app is
 * turned on, the personal edition gives every Bot every action, the Bot's tools are read the way a
 * run reads them (`grantedTools`), and then cut to what a crowded endpoint request has room for.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const slug = `gmail${suite}`;
const serverId = `composio-${slug}`;
const bot = `gmail-reads-bot-${suite}`;
const owner = `gmail-reads-owner-${suite}`;

/** The actions that find, list and read messages and threads. */
const READS = [
  "GMAIL_FETCH_EMAILS",
  "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  "GMAIL_LIST_MESSAGES",
  "GMAIL_LIST_THREADS",
];

const broker: ConnectedAppBroker = {
  grantIsLocal: true,
  authProviderOf: async () => null,
  authorizations: null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "created",
  deleteAuthConfig: async () => undefined,
  authorize: async () => {
    throw new Error("nothing here begins a connection");
  },
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => {
    throw new Error("nothing here connects an account");
  },
  revokeAccount: async () => {},
  accountName: async () => null,
};

const store = withPersonalDefaults(
  createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    brokerProvider: "composio",
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
  }),
  {
    ...personalDefaultsDeps(database),
    // Only this suite's Bot, so nobody else's is given anything.
    bots: async () => [bot],
  },
);

beforeAll(async () => {
  setEdition("personal");
  // Composio's listing, as the adapter reads each row it is sent.
  useComposioClient({
    listActions: async () =>
      captured.gmail.map((row, position) =>
        actionOf(row as VendorToolRow, position, "gmail"),
      ),
    execute: async () => ({ data: {}, error: null, successful: true }),
  });
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database
    .insert(agents)
    .values({ id: bot, name: bot, type: "remote_ag_ui", configuration: {} });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: owner,
    title: "Personal Assistant",
    roleDescription: "Assist",
    avatarSeed: bot,
    visibility: "private",
  });
});

afterEach(() => setEdition("personal"));

afterAll(async () => {
  setEdition("team");
  useComposioClient(null);
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, bot));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agentProfiles).where(eq(agentProfiles.agentId, bot));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

test("a Bot with Gmail connected holds every action, and its reads are marked as reads", async () => {
  await store.addBrokeredApp({
    slug,
    title: "Gmail",
    by: "person@openbot.test",
    connection: { kind: "consent" },
  });

  const held = await grantedTools({
    store,
    botId: bot,
    actorId: owner,
  });
  const gmail = held.filter((tool) => tool.ref.startsWith(`${serverId}/`));
  expect(gmail).toHaveLength(captured.gmail.length);

  const action = (tool: (typeof gmail)[number]) =>
    tool.ref.slice(serverId.length + 1);
  const all = gmail.map(action);
  const reads = gmail.filter((tool) => tool.reads === true).map(action);
  for (const name of READS) expect(reads).toContain(name);
  // A write is held, and never marked a read, so it still asks before it runs.
  for (const name of [
    "GMAIL_SEND_EMAIL",
    "GMAIL_DELETE_MESSAGE",
    "GMAIL_UPDATE_POP_SETTINGS",
  ]) {
    expect(all).toContain(name);
    expect(reads).not.toContain(name);
  }
});

test("cut to what a crowded request has room for, the Bot is still sent the actions that read its mail", async () => {
  const held = await grantedTools({
    store,
    botId: bot,
    actorId: owner,
  });
  // OpenBot's own tools, sent on every step, leave room for eleven of Gmail's, as in the report.
  const own = Array.from({ length: 20 }, (_, index) => ({
    name: `own_tool_${index}`,
    ref: `openbot/own_${index}`,
    description: `OpenBot tool ${index}`,
    parameters: held[0]?.parameters as never,
    execute: async () => "",
  }));
  const sent = (text: string) =>
    fitToolLimit([...own, ...held], { limit: own.length + 11, text })
      .map((tool) => tool.ref)
      .filter((ref) => ref.startsWith(`${serverId}/`))
      .map((ref) => ref.slice(serverId.length + 1));

  const reading = sent(
    "Find the emails I got about the offsite and read me their subjects and what they say",
  );
  expect(reading).toContain("GMAIL_FETCH_EMAILS");
  expect(reading).toContain("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID");

  // A follow-up that names nothing is offered reads first.
  const followUp = sent("yes please, go ahead");
  for (const action of [
    "GMAIL_FETCH_EMAILS",
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
  ])
    expect(followUp).toContain(action);

  // Asking to send still offers the send.
  expect(sent("Send an email to Sam saying I'm running late")).toContain(
    "GMAIL_SEND_EMAIL",
  );
});
