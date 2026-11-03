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
// registry, on loopback. Missing, every test that touches a Bot fails here and says so, rather than
// skipping and reporting a pass for a suite that never ran.
import { randomUUID } from "node:crypto";
import { createAgentRegistryClient } from "../../src/agents/bot-registry/client";
import {
  type BotDirectory,
  createBotDirectory,
  installBotDirectory,
} from "../../src/agents/bot-registry/directory";
import { removeBotLocalRows } from "../../src/agents/bot-registry/local-rows";
import type {
  Bot,
  BotChanges,
  BotType,
} from "../../src/agents/bot-registry/types";
import { createDatabase } from "../../src/db/client";
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

let started: Promise<BotDirectory> | undefined;

/**
 * The process's Bot directory, against the test Intelligence, installed and loaded. Once per process:
 * every file shares it, as every file shares the test database.
 */
export function useTestBots(): Promise<BotDirectory> {
  started ??= (async () => {
    const intelligence = testIntelligence();
    const directory = installBotDirectory(
      createBotDirectory({
        registry: createAgentRegistryClient({
          apiUrl: intelligence.apiUrl,
          apiKey: intelligence.apiKey,
        }),
        gatewayWsUrl: intelligence.gatewayWsUrl,
      }),
    );
    // The same cleanup the server wires: a purged Bot takes its rows here with it.
    const database = createDatabase(testDatabaseUrl(), { max: 1 });
    directory.onPurged((botId) => removeBotLocalRows(database, [botId]));
    await directory.start();
    // Every Bot's routines, check-ins and responsibilities live in Intelligence too, and much of what
    // a Bot test drives reads them (a channel's work, a Bot's activity), so the schedule directory
    // starts with the Bots, as it does in the server.
    const schedules = await (await import("./schedules")).useTestSchedules();
    // As the server does: Intelligence purges a purged Bot's schedules, and this process forgets them.
    directory.onPurged(() => schedules.resync());
    return directory;
  })();
  return started;
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
