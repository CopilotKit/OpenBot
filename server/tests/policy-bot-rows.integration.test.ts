import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BotDirectory } from "../src/agents/bot-registry/directory";
import type { PolicyCache } from "../src/policy/cache";
import { removeBotPolicy, sweepPurgedBotPolicy } from "../src/policy/bot-rows";
import { removeBots, seedBot, useTestBots } from "./support/bots";
import { storedConnectionApprovals, useTestPolicy } from "./support/policy";

/**
 * A Bot deleted for good takes its Shared app approvals with it, as the old foreign key took them,
 * and a Bot made again under the same id keeps what it is given afterwards.
 */

const suite = randomUUID().slice(0, 8);
const connectionId = `team-app-${suite}`;
let cache: PolicyCache;
let directory: BotDirectory;
const gone = async (id: string) => (await directory.registry.get(id)) === null;

const approve = (agentId: string) =>
  cache.putConnectionApproval(
    { agentId, connectionId },
    {
      audience: "owner",
      outsideInput: false,
      members: [],
      approvedBy: "admin@example.test",
      approvedAs: "admin",
    },
  );

beforeAll(async () => {
  cache = await useTestPolicy();
  directory = await useTestBots();
});

afterAll(async () => {
  for (const approval of await storedConnectionApprovals({ connectionId }))
    await cache.deleteConnectionApproval(approval);
});

describe("a purged Bot's Shared app approvals", () => {
  test("go with it", async () => {
    const bot = await seedBot();
    await approve(bot.id);
    await removeBots([bot.id]);
    expect(await storedConnectionApprovals({ agentId: bot.id })).toEqual([]);
  });

  test("a late purge announcement leaves the approval of a Bot made again under the same id", async () => {
    // Purged on another server, made again here and given an approval, and only then does this
    // server hear the purge. The old Bot's approvals are already gone; the new one's must stay.
    const id = `bot-again-${suite}`;
    await seedBot({ id });
    await removeBots([id]);
    await seedBot({ id });
    await approve(id);

    await removeBotPolicy(cache, [id], gone);

    expect(await storedConnectionApprovals({ agentId: id })).toHaveLength(1);
    await removeBots([id]);
  });

  test("a boot sweep removes the approvals of a Bot purged while no server was running", async () => {
    const orphan = `bot-orphan-${suite}`;
    // An approval naming a Bot Intelligence never had (or purged while every server was down).
    await approve(orphan);
    const swept = await sweepPurgedBotPolicy(
      cache,
      async () => (await directory.registry.all({ includeDeleted: true })).bots,
      gone,
    );
    expect(swept).toContain(orphan);
    expect(await storedConnectionApprovals({ agentId: orphan })).toEqual([]);
  });
});
