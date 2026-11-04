// server/tests/support/bots.ts
//
// Bots for the tests, in a real Intelligence.
//
// Bots live in Intelligence's agent registry, so a test that needs one makes it there, through the
// same directory the server uses, and reads it back the way the server does. There is no stand-in:
// a fake registry that passed while the real one refused would be exactly the test that lies.
//
// WHICH INTELLIGENCE. `TEST_INTELLIGENCE_API_URL`, `TEST_INTELLIGENCE_API_KEY` and
// `TEST_INTELLIGENCE_GATEWAY_WS_URL` name it: a local self-hosted Intelligence with its agent
// registry, on loopback. `TEST_INTELLIGENCE_API_KEY_2` names a second project in it, for the tests
// that run another deployment beside the first (`secondTestProject`). Missing, every test that needs
// one fails here and says so, rather than skipping and reporting a pass for a suite that never ran.
import { randomUUID } from "node:crypto";
import { createAgentRegistryClient } from "../../src/agents/bot-registry/client";
import {
  type BotDirectory,
  createBotDirectory,
  installBotDirectory,
} from "../../src/agents/bot-registry/directory";
import { removeBotLocalRows } from "../../src/agents/bot-registry/local-rows";
import { createConfigurationClient } from "../../src/configuration/client";
import {
  type BotConfiguration,
  createBotConfiguration,
  installBotConfiguration,
} from "../../src/configuration/directory";
import type {
  BotAccess,
  BotAccessChange,
  GrantKind,
  PersonPreferences,
  PersonPreferencesChange,
} from "../../src/configuration/types";
import type {
  Bot,
  BotChanges,
  BotType,
} from "../../src/agents/bot-registry/types";
import { forgetPurgedBot } from "../../src/conversations/bot-purge";
import { createDatabase } from "../../src/db/client";
import { startTestConversationDirectories } from "./conversations";
import { testDatabaseUrl } from "./database";

export type TestIntelligence = {
  apiUrl: string;
  apiKey: string;
  gatewayWsUrl: string;
};

/** The Intelligence the tests run against, from the environment. Throws, loudly, when it is not set. */
export function testIntelligence(
  environment: Record<string, string | undefined> = process.env,
): TestIntelligence {
  const apiUrl = environment.TEST_INTELLIGENCE_API_URL?.trim();
  const apiKey = environment.TEST_INTELLIGENCE_API_KEY?.trim();
  const gatewayWsUrl = environment.TEST_INTELLIGENCE_GATEWAY_WS_URL?.trim();
  const missing = [
    !apiUrl && "TEST_INTELLIGENCE_API_URL",
    !apiKey && "TEST_INTELLIGENCE_API_KEY",
    !gatewayWsUrl && "TEST_INTELLIGENCE_GATEWAY_WS_URL",
  ].filter(Boolean);
  if (!apiUrl || !apiKey || !gatewayWsUrl) {
    throw new Error(
      `${missing.join(", ")} must name a running Intelligence with the agent registry (a local self-hosted one, on 127.0.0.1). Bots live there, and these tests make and read real ones. See server/tests/support/bots.ts.`,
    );
  }
  return { apiUrl, apiKey, gatewayWsUrl };
}

/**
 * A second Intelligence project in the test organization: ANOTHER DEPLOYMENT, for a test about two
 * deployments that must not see each other's vault, apps, connections or people, or one that fills a
 * project of its own. Same API and gateway
 * as the first project; its key is `TEST_INTELLIGENCE_API_KEY_2`, failing by name when missing.
 */
export function secondTestProject(
  environment: Record<string, string | undefined> = process.env,
): ReturnType<typeof testIntelligence> {
  const first = testIntelligence(environment);
  const apiKey = environment.TEST_INTELLIGENCE_API_KEY_2?.trim();
  if (!apiKey || apiKey === first.apiKey) {
    throw new Error(
      "TEST_INTELLIGENCE_API_KEY_2 must name a second project in the test Intelligence, other than TEST_INTELLIGENCE_API_KEY's. A deployment's data is its project's, so two deployments need two. See server/tests/support/bots.ts.",
    );
  }
  return { ...first, apiKey };
}

let started: Promise<BotDirectory> | undefined;
let configured: BotConfiguration | undefined;

/**
 * The process's Bot directory and Bot configuration (grants, publications, people's preferences,
 * components, skills), against the test Intelligence, installed and loaded. Once per process: every
 * file shares them, as every file shares the test database.
 */
export function useTestBots(): Promise<BotDirectory> {
  started ??= (async () => {
    const intelligence = testIntelligence();
    const registry = createAgentRegistryClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    });
    const directory = installBotDirectory(
      createBotDirectory({
        registry,
        gatewayWsUrl: intelligence.gatewayWsUrl,
      }),
    );
    const configuration = installBotConfiguration(
      createBotConfiguration({
        client: createConfigurationClient({
          apiUrl: intelligence.apiUrl,
          apiKey: intelligence.apiKey,
        }),
        registry,
        gatewayWsUrl: intelligence.gatewayWsUrl,
      }),
    );
    configured = configuration;
    // The same cleanup the server wires: a purged Bot takes its rows here with it, and what this
    // process holds about it.
    const database = createDatabase(testDatabaseUrl(), { max: 1 });
    directory.onPurged((botId) => removeBotLocalRows(database, [botId]));
    directory.onPurged((botId) => configuration.botPurged(botId));
    await directory.start();
    await configuration.start();
    // Conversations and delivery bindings are in Intelligence too, and every store that names a Bot
    // reads them through directories of their own: started with the Bots, as the server starts them.
    const { conversations, delivery } =
      await startTestConversationDirectories();
    // And, as the server wires it, a purged Bot is forgotten in conversations and bindings.
    directory.onPurged((botId) =>
      forgetPurgedBot(conversations, delivery, botId),
    );
    // Every Bot's routines, check-ins and responsibilities live in Intelligence too, and much of what
    // a Bot test drives reads them (a channel's work, a Bot's activity), so the schedule directory
    // starts with the Bots, as it does in the server.
    await (await import("./schedules")).useTestSchedules();
    return directory;
  })();
  return started;
}

/** The process's Bot configuration, installed and loaded with the Bot directory. */
export async function useTestConfiguration(): Promise<BotConfiguration> {
  await useTestBots();
  if (!configured) throw new Error("The Bot configuration did not start.");
  return configured;
}

/**
 * Give a Bot a tool (`mcp`), a skill or another Bot, in Intelligence, as a test's setup. The grant the
 * old tests inserted into `plugin_grants`.
 */
export async function grantBot(
  botId: string,
  kind: GrantKind,
  ref: string,
  options: { grantedBy?: string | null; grantedAs?: "admin" | "owner" } = {},
): Promise<void> {
  await (await useTestConfiguration()).changeAccess([
    {
      op: "grant",
      botId,
      kind,
      ref,
      grantedBy: options.grantedBy ?? "test",
      grantedAs: options.grantedAs ?? "admin",
      ifGranted: "replace",
    },
  ]);
}

/** Any change to Bots' access, as a test's setup or cleanup. */
export async function changeAccess(changes: BotAccessChange[]): Promise<void> {
  await (await useTestConfiguration()).changeAccess(changes);
}

/** Any change to one person's preferences, as a test's setup. */
export async function changePreferences(
  userId: string,
  changes: PersonPreferencesChange[],
): Promise<PersonPreferences> {
  return (
    await (await useTestConfiguration()).changePreferences(userId, changes)
  ).preferences;
}

/** A Bot's access as Intelligence holds it now, past this process's memory. */
export async function storedAccess(botId: string): Promise<BotAccess> {
  const configuration = await useTestConfiguration();
  return (
    (await configuration.client.access.get(botId)) ?? {
      botId,
      revision: 0,
      grants: [],
      publication: null,
      assignments: [],
    }
  );
}

/** A person's preferences as Intelligence holds them now, past this process's memory. */
export async function storedPreferences(
  userId: string,
): Promise<PersonPreferences> {
  return (await useTestConfiguration()).client.preferences.get(userId);
}

export type SeedBot = {
  id?: string;
  name?: string;
  type?: BotType;
  configuration?: Record<string, unknown>;
  packageId?: string | null;
  ownerUserId?: string | null;
  title?: string;
  roleDescription?: string;
  avatarSeed?: string;
  visibility?: "public" | "private";
  isolated?: boolean;
  callbackTokenHash?: string | null;
  deletedAt?: Date | null;
};

/**
 * Make a Bot in Intelligence, for a test. Every field has a default that makes a working remote Bot
 * nobody owns and only an administrator sees; a test names what it is about.
 */
export async function seedBot(input: SeedBot = {}): Promise<Bot> {
  const directory = await useTestBots();
  const id = input.id ?? `test-bot-${randomUUID()}`;
  const type = input.type ?? "remote_ag_ui";
  return directory.create({
    id,
    type,
    name: input.name ?? `Test Bot ${id.slice(-8)}`,
    configuration:
      input.configuration ??
      (type === "built_in"
        ? { systemPrompt: "You help with tests." }
        : { endpoint: "https://agent.example.test/ag-ui" }),
    packageId: input.packageId ?? null,
    ownerUserId: input.ownerUserId ?? null,
    title: input.title ?? "Test Assistant",
    roleDescription: input.roleDescription ?? "Helps the tests.",
    avatarSeed: input.avatarSeed ?? id,
    visibility: input.visibility ?? "private",
    isolated: input.isolated ?? false,
    ...(input.callbackTokenHash
      ? { callbackTokenHash: input.callbackTokenHash }
      : {}),
    ...(input.deletedAt ? { deletedAt: input.deletedAt } : {}),
  });
}

/** Soft-delete a Bot, as deleting it from its page does. */
export async function deleteBot(id: string): Promise<Bot> {
  return (await useTestBots()).remove(id);
}

/**
 * Remove Bots for good, and this deployment's rows that named them, as test cleanup. The old
 * `delete from agents` did both through the foreign keys.
 */
export async function removeBots(ids: readonly string[]): Promise<void> {
  const directory = await useTestBots();
  for (const id of ids) await directory.purge(id);
}

/** The Bot as Intelligence holds it now, past this process's memory. Throws when there is none. */
export async function storedBot(id: string): Promise<Bot> {
  const bot = await (await useTestBots()).registry.get(id);
  if (!bot) throw new Error(`Intelligence has no Bot ${id}`);
  return bot;
}

/**
 * Change a Bot the way an edit does, at its current version, through the directory so this process
 * sees the change at once. For a test that used to `update` the `agents` or `agent_profiles` row.
 */
export async function changeBot(id: string, changes: BotChanges): Promise<Bot> {
  const directory = await useTestBots();
  const current = await storedBot(id);
  return directory.update(id, current.version, changes);
}

/**
 * Remove everything these people set, in Intelligence and in this process's copy: the cleanup the old
 * tests did by deleting their `bot_lifecycle`, `update_routing_preferences`, `default_opt_outs` and
 * consent rows.
 */
export async function clearPreferences(
  userIds: readonly string[],
): Promise<void> {
  const configuration = await useTestConfiguration();
  for (const userId of userIds) {
    await configuration.client.preferences.purge(
      userId,
      `test:purge:${randomUUID()}`,
    );
    configuration.preferences.forget(userId);
  }
}

/** Pause one person's Bot, or set how loudly it may reach them, as a test's setup. */
export async function setBotPreference(
  userId: string,
  botId: string,
  values: {
    pausedAt?: Date | null;
    notify?: "all" | "needs_input" | "none";
    hiddenAt?: Date | null;
    pinnedAt?: Date | null;
  },
): Promise<void> {
  await changePreferences(userId, [{ op: "setBot", botId, ...values }]);
}

/** Every package name a test in this process recorded, and has not removed yet. */
const testPackages = new Set<string>();

/**
 * Note a package name a test is about to record some other way than `recordTestPackage` (by running
 * the real sync, say), so `removeTestPackages` purges it too.
 */
export function trackTestPackage(name: string): string {
  testPackages.add(name);
  return name;
}

/**
 * Purge the package records this process's tests made, so a run leaves Intelligence's package list as
 * it found it. A name already gone is fine.
 */
export async function removeTestPackages(
  names: Iterable<string> = testPackages,
): Promise<void> {
  const configuration = await useTestConfiguration();
  for (const name of [...names]) {
    await configuration.client.packages.remove(name, `test:${randomUUID()}`);
    testPackages.delete(name);
  }
}

/**
 * A tenant package, recorded in Intelligence as the server records the one it applies, for a test
 * that needs a package's id (a package's Bots and channels name it). The local row the old tests
 * inserted into `deployment_packages`. `removeTestPackages` purges it.
 */
export async function recordTestPackage(
  name: string,
  input: { source?: string; checksum?: string } = {},
): Promise<{ id: string }> {
  trackTestPackage(name);
  return (await useTestConfiguration()).client.packages.record(
    name,
    {
      source: input.source ?? "test/package",
      checksum: input.checksum ?? randomUUID(),
    },
    `test:${randomUUID()}`,
  );
}

/**
 * A component in the catalogue, in Intelligence, as a test's setup: the row the old tests inserted
 * into `components`. Held in this process's copy at once.
 */
export async function makeTestComponent(
  name: string,
  input: {
    published: boolean;
    title?: string;
    kind?: string;
    draftDescription?: string;
    publishedDescription?: string | null;
  },
): Promise<void> {
  const configuration = await useTestConfiguration();
  configuration.components.apply(
    await configuration.client.components.create(
      name,
      {
        title: input.title ?? `Test ${name}`,
        kind: input.kind ?? "chart",
        draftDescription: input.draftDescription ?? "The draft wording.",
        publishedDescription:
          input.publishedDescription !== undefined
            ? input.publishedDescription
            : input.published
              ? "The published wording."
              : null,
        published: input.published,
        publishedAt: input.published ? new Date() : null,
        updatedBy: null,
        functions: [],
        withheldFrom: [],
        source: null,
      },
      `test:${randomUUID()}`,
    ),
  );
}

/** Remove components for good, in Intelligence and this process's copy, as test cleanup. */
export async function removeTestComponents(
  names: Iterable<string>,
): Promise<void> {
  const configuration = await useTestConfiguration();
  for (const name of names) {
    await configuration.client.components.remove(name, `test:${randomUUID()}`);
    configuration.components.forget(name);
  }
}

/** A component as Intelligence holds it now, past this process's memory. Null when there is none. */
export async function storedComponent(name: string) {
  return (await useTestConfiguration()).client.components.get(name);
}
