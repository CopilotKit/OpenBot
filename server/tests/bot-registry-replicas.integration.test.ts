/**
 * Two OpenBot replicas see the same Bots: what one writes, the other reads.
 *
 * Each replica holds every Bot in memory (`agents/bot-registry/directory.ts`). Run against the real
 * test Intelligence and its realtime gateway, two directories here stand for two server instances:
 * a write on one reaches the other's memory through Intelligence's announcement, a miss reads through,
 * a stale write is refused rather than overwriting a newer one, and a purge runs the other replica's
 * cleanup. Then the registry's own guarantees the directory depends on: every page of a listing, and a
 * create retried under the same key making one Bot.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BotAlreadyExistsError,
  BotVersionConflictError,
  createAgentRegistryClient,
} from "../src/agents/bot-registry/client";
import {
  type BotDirectory,
  createBotDirectory,
} from "../src/agents/bot-registry/directory";
import type { BotDraft } from "../src/agents/bot-registry/types";
import { removeBots, testIntelligence } from "./support/bots";

const intelligence = testIntelligence();
const replicas: BotDirectory[] = [];
const made: string[] = [];

function replica(): BotDirectory {
  const directory = createBotDirectory({
    registry: createAgentRegistryClient(intelligence),
    gatewayWsUrl: intelligence.gatewayWsUrl,
  });
  replicas.push(directory);
  return directory;
}

const a = replica();
const b = replica();

// Its own budget: starting both replicas and waiting up to 8 s for their subscriptions does not fit bun's 5 s hook
// default, which failed the whole file whenever the gateway took longer than that to join.
beforeAll(async () => {
  await Promise.all([a.start(), b.start()]);
  // Both subscriptions joined before anything is written, so announcements have somewhere to go.
  await eventually(() => a.subscribed() && b.subscribed());
}, 30_000);

afterAll(async () => {
  for (const directory of replicas) directory.stop();
  await removeBots(made);
});

async function eventually<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean = Boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline)
      throw new Error(`Not within ${timeoutMs}ms: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function draft(overrides: Partial<BotDraft> = {}): BotDraft {
  const id = `replica-${randomUUID()}`;
  made.push(overrides.id ?? id);
  return {
    id,
    type: "remote_ag_ui",
    name: "Replica Bot",
    title: "Tester",
    roleDescription: "Is written on one replica and read on another.",
    avatarSeed: id,
    visibility: "public",
    ownerUserId: null,
    packageId: null,
    isolated: false,
    configuration: { endpoint: "https://replica.example.test/ag-ui" },
    ...overrides,
  };
}

describe("two replicas", () => {
  test("a Bot made on one is found on the other at once, by reading through on a miss", async () => {
    const bot = await a.create(draft());
    const found = await b.find(bot.id);
    expect(found).toMatchObject({
      id: bot.id,
      name: "Replica Bot",
      version: 1,
    });
  });

  test("a change on one reaches the other's memory without being asked for", async () => {
    const bot = await a.create(draft());
    await eventually(() => b.peek(bot.id));
    await a.update(bot.id, bot.version, { name: "Renamed on A" });
    const seen = await eventually(
      () => b.peek(bot.id),
      (held) => held?.name === "Renamed on A",
    );
    expect(seen?.version).toBe(2);
  });

  test("a delete and a restore reach the other replica too", async () => {
    const bot = await a.create(draft());
    await eventually(() => b.peek(bot.id));
    await a.remove(bot.id);
    await eventually(
      () => b.peek(bot.id),
      (held) => held?.deletedAt !== null,
    );
    expect(b.live().some((held) => held.id === bot.id)).toBe(false);
    await a.restore(bot.id);
    await eventually(
      () => b.peek(bot.id),
      (held) => held !== undefined && held.deletedAt === null,
    );
  });

  test("a write made from a stale copy is refused, and nothing older replaces something newer", async () => {
    const bot = await a.create(draft());
    const seenByB = await b.find(bot.id);
    if (!seenByB) throw new Error("Expected B to read the Bot.");
    await a.update(bot.id, bot.version, { title: "A saved first" });
    await expect(
      b.update(bot.id, seenByB.version, { title: "B saved second" }),
    ).rejects.toBeInstanceOf(BotVersionConflictError);
    const current = await b.refresh(bot.id);
    expect(current).toMatchObject({ title: "A saved first", version: 2 });
  });

  test("a purge on one replica runs the other's cleanup and leaves both memories", async () => {
    const purged: string[] = [];
    const stop = b.onPurged((id) => {
      purged.push(id);
    });
    try {
      const bot = await a.create(draft());
      await eventually(() => b.peek(bot.id));
      await a.purge(bot.id);
      await eventually(
        () => purged,
        (ids) => ids.includes(bot.id),
      );
      expect(b.peek(bot.id)).toBeUndefined();
      expect(await b.find(bot.id)).toBeNull();
    } finally {
      stop();
    }
  });

  test("a full read on a replica that missed an announcement catches it up", async () => {
    const quiet = createBotDirectory({
      registry: createAgentRegistryClient(intelligence),
    });
    replicas.push(quiet);
    await quiet.start();
    const bot = await a.create(draft());
    expect(quiet.peek(bot.id)).toBeUndefined();
    await quiet.resync();
    expect(quiet.peek(bot.id)?.id).toBe(bot.id);
  });
});

describe("the registry under the directory", () => {
  test("a listing has no cap: every page is walked to the end", async () => {
    const owner = `paging-owner-${randomUUID()}`;
    const count = 120;
    for (let index = 0; index < count; index += 1) {
      await a.registry.create(
        draft({ ownerUserId: owner, name: `Paged ${index}` }),
        `test:${randomUUID()}`,
      );
    }
    const firstPage = await a.registry.page({ ownerUserId: owner });
    expect(firstPage.bots).toHaveLength(100);
    expect(firstPage.nextCursor).not.toBeNull();
    const { bots: all } = await a.registry.all({ ownerUserId: owner });
    expect(all).toHaveLength(count);
    expect(new Set(all.map((bot) => bot.id)).size).toBe(count);
  });

  test("a create retried under its key is one Bot; under another key it is refused", async () => {
    const body = draft();
    const key = `test:${randomUUID()}`;
    const first = await a.registry.create(body, key);
    const retried = await a.registry.create(body, key);
    expect(retried).toMatchObject({ id: first.id, version: 1 });
    await expect(
      a.registry.create(body, `test:${randomUUID()}`),
    ).rejects.toBeInstanceOf(BotAlreadyExistsError);
  });
});
