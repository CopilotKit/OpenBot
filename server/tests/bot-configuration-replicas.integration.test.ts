/**
 * Two server instances, one Intelligence: what one changes, the other serves from memory without a
 * restart, and a one-time Team Bot consent is spent exactly once between them.
 *
 * Each "replica" here is a Bot configuration of its own (configuration/directory.ts) with its own
 * subscription to Intelligence's realtime gateway, as two OpenBot servers have. The test process's own
 * configuration is a third.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAgentRegistryClient } from "../src/agents/bot-registry/client";
import { createConfigurationClient } from "../src/configuration/client";
import {
  type BotConfiguration,
  createBotConfiguration,
} from "../src/configuration/directory";
import { removeBots, seedBot, testIntelligence } from "./support/bots";

setDefaultTimeout(20_000);

const replicas: BotConfiguration[] = [];
const made: string[] = [];

afterAll(async () => {
  for (const replica of replicas) replica.stop();
  await removeBots(made);
});

async function replica(options: { listening?: boolean } = {}) {
  const intelligence = testIntelligence();
  const configuration = createBotConfiguration({
    client: createConfigurationClient(intelligence),
    registry: createAgentRegistryClient(intelligence),
    gatewayWsUrl:
      options.listening === false ? undefined : intelligence.gatewayWsUrl,
    resyncIntervalMs: 3_600_000,
  });
  await configuration.start();
  replicas.push(configuration);
  return configuration;
}

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(25);
  return check();
}

describe("Bot configuration across replicas", () => {
  test("a grant, a publication and a pause made on one reach the other from its announcements", async () => {
    const one = await replica();
    const two = await replica();
    const bot = await seedBot({ ownerUserId: `owner-${randomUUID()}` });
    made.push(bot.id);
    const person = `person-${randomUUID()}`;

    await one.changeAccess([
      {
        op: "grant",
        botId: bot.id,
        kind: "mcp",
        ref: "github/create_issue",
        grantedBy: "admin",
        grantedAs: "admin",
        ifGranted: "replace",
      },
      {
        op: "publish",
        botId: bot.id,
        audience: "team",
        members: [],
        publishedBy: "admin",
      },
    ]);
    await one.changePreferences(person, [
      { op: "setBot", botId: bot.id, pausedAt: new Date() },
    ]);

    expect(
      await until(
        () =>
          two.accessOf(bot.id).grants.length === 1 &&
          two.accessOf(bot.id).publication !== null &&
          two.preferencesOf(person).bots[0]?.pausedAt !== null &&
          two.preferencesOf(person).bots.length === 1,
      ),
    ).toBe(true);

    // And a revocation, which is what has to reach the next tool call on every replica.
    await one.changeAccess([
      { op: "revoke", botId: bot.id, kind: "mcp", ref: "github/create_issue" },
    ]);
    expect(await until(() => two.accessOf(bot.id).grants.length === 0)).toBe(
      true,
    );
  });

  test("a replica that heard nothing catches up on its next full read", async () => {
    const deaf = await replica({ listening: false });
    const loud = await replica();
    const bot = await seedBot();
    made.push(bot.id);
    await loud.changeAccess([
      {
        op: "grant",
        botId: bot.id,
        kind: "skill",
        ref: `skill-${randomUUID()}`,
        grantedBy: "admin",
        grantedAs: "admin",
        ifGranted: "replace",
      },
    ]);
    expect(deaf.accessOf(bot.id).grants).toEqual([]);
    await deaf.resync();
    expect(deaf.accessOf(bot.id).grants).toHaveLength(1);
  });

  test("a one-time consent is spent by exactly one call across replicas", async () => {
    const replicaOne = await replica();
    const replicaTwo = await replica();
    const bot = await seedBot();
    made.push(bot.id);
    const teammate = `teammate-${randomUUID()}`;
    await replicaOne.changePreferences(teammate, [
      { op: "setConsent", botId: bot.id, serverId: "gmail", decision: "once" },
    ]);

    const spent = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? replicaOne : replicaTwo).consumeConsent(
          teammate,
          bot.id,
          "gmail",
        ),
      ),
    );
    expect(spent.filter(Boolean)).toHaveLength(1);
    expect(replicaOne.preferencesOf(teammate).consents).toEqual([]);
    expect(
      await until(
        () => replicaTwo.preferencesOf(teammate).consents.length === 0,
      ),
    ).toBe(true);

    // An "always" is never spent.
    await replicaOne.changePreferences(teammate, [
      {
        op: "setConsent",
        botId: bot.id,
        serverId: "gmail",
        decision: "always",
      },
    ]);
    expect(await replicaTwo.consumeConsent(teammate, bot.id, "gmail")).toBe(
      false,
    );
    expect(replicaOne.preferencesOf(teammate).consents).toHaveLength(1);
  });

  test("a Bot purged for good leaves nothing behind on any replica", async () => {
    const one = await replica();
    const bot = await seedBot();
    const person = `person-${randomUUID()}`;
    await one.changeAccess([
      {
        op: "grant",
        botId: bot.id,
        kind: "bot",
        ref: "helper",
        grantedBy: "admin",
        grantedAs: "admin",
        ifGranted: "replace",
      },
    ]);
    await one.changePreferences(person, [
      { op: "setBot", botId: bot.id, pinnedAt: new Date() },
    ]);
    await removeBots([bot.id]);
    expect(
      await until(
        () =>
          one.access.get(bot.id) === undefined &&
          one.preferencesOf(person).bots.length === 0,
      ),
    ).toBe(true);
  });
});
