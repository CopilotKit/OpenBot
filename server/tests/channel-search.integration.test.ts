import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import {
  ChannelSearchInputError,
  type ChannelSummary,
  createChannelRoutes,
  createChannelStore,
  SEARCH_CURSOR_ERROR,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  botTasks,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Search reads the same roster `list` does, narrowed in the database before the page is cut. These
 * run against a real PostgreSQL because the rules that matter here (membership, deletion, the
 * pattern escaping, the collation's case folding, the keyset cursor) only exist in SQL.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);

const testPrefix = `channel-search-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Channel Search Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createBot(
  owner: AgentActor,
  name = "Expense Manager",
  visibility: "public" | "private" = "private",
) {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility,
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

type Roster = {
  summary?: string | null;
  title?: string | null;
  opening?: string | null;
  lastMessage?: string | null;
  lastMessageAt?: Date | null;
};

/** A conversation of `owner`'s with these roster columns, written straight to the row. */
async function conversation(
  owner: AgentActor,
  agentId: string,
  roster: Roster = {},
) {
  const channel = await store.create(owner, [agentId]);
  createdChannelIds.push(channel.id);
  if (Object.keys(roster).length > 0) {
    await database
      .update(channels)
      .set(roster)
      .where(eq(channels.id, channel.id));
  }
  return channel.id;
}

/** Add `member` to a conversation the way a group does: a membership and a thread of their own. */
async function join(member: AgentActor, channelId: string) {
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: member.id });
  await database.insert(intelligenceChannelMappings).values({
    userId: member.id,
    channelId,
    threadId: randomUUID(),
  });
}

async function searchIds(actor: AgentActor, query: string, limit?: number) {
  const page = await store.search(actor, {
    query,
    ...(limit ? { limit } : {}),
  });
  return page.channels.map((channel) => channel.id);
}

/** Every page of a search, in order, by following its cursor. */
async function everyPage(actor: AgentActor, query: string, limit: number) {
  const rows: ChannelSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await store.search(actor, {
      query,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...result.channels);
    if (!result.nextCursor) return rows;
    cursor = result.nextCursor;
  }
  throw new Error("The search never reached its last page.");
}

function appAs(actor: AgentActor) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createChannelRoutes(store, requireUser));
  return app;
}

describe("conversation search", () => {
  test("matches the name, the summary, a chosen title, the opening and the last message", async () => {
    const owner = await createUser();
    const bot = await createBot(owner, "Quillfeather");
    const byName = await conversation(owner, bot);
    const bySummary = await conversation(owner, bot, {
      summary: "Quarterly travel receipts",
    });
    const byTitle = await conversation(owner, bot, {
      summary: "Old words",
      title: "Offsite lodging plan",
    });
    const byOpening = await conversation(owner, bot, {
      opening: "Can you find the lodging invoice?",
    });
    const byLast = await conversation(owner, bot, {
      lastMessage: "The lodging invoice is attached.",
      lastMessageAt: new Date(),
    });

    expect(await searchIds(owner, "quillfeather")).toHaveLength(5);
    expect(await searchIds(owner, "TRAVEL RECEIPTS")).toEqual([bySummary]);
    expect(await searchIds(owner, "offsite")).toEqual([byTitle]);
    // The sweep's summary is not what the row shows once a title is chosen, so it does not match.
    expect(await searchIds(owner, "old words")).toEqual([]);
    expect((await searchIds(owner, "lodging")).sort()).toEqual(
      [byTitle, byOpening, byLast].sort(),
    );
    expect(await searchIds(owner, "attached")).toEqual([byLast]);
    expect(await searchIds(owner, "nothing like this")).toEqual([]);
    expect(byName).toBeString();
  });

  test("treats %, _ and backslash as the characters they are", async () => {
    const owner = await createUser();
    const bot = await createBot(owner);
    const percent = await conversation(owner, bot, {
      summary: "Budget is 100% spent",
    });
    await conversation(owner, bot, { summary: "Budget is 1000 spent" });
    const underscore = await conversation(owner, bot, {
      summary: "Rename report_final",
    });
    await conversation(owner, bot, { summary: "Rename reportXfinal" });
    const backslash = await conversation(owner, bot, {
      summary: "Path C:\\Users\\ana",
    });
    await conversation(owner, bot, { summary: "Path C:Usersana" });

    expect(await searchIds(owner, "0% s")).toEqual([percent]);
    expect(await searchIds(owner, "%%")).toEqual([]);
    expect(await searchIds(owner, "t_f")).toEqual([underscore]);
    expect(await searchIds(owner, "__")).toEqual([]);
    expect(await searchIds(owner, ":\\Users")).toEqual([backslash]);
    expect(await searchIds(owner, "\\\\")).toEqual([]);
    // Quotes and SQL are text like any other.
    expect(await searchIds(owner, "' or 1=1 --")).toEqual([]);
  });

  test("ignores case beyond ASCII and composes accents before comparing", async () => {
    const owner = await createUser();
    const bot = await createBot(owner);
    const french = await conversation(owner, bot, {
      summary: "Inscription à l'école",
    });
    const russian = await conversation(owner, bot, {
      opening: "Привет, где отчёт?",
    });
    const emoji = await conversation(owner, bot, {
      lastMessage: "Ship it 🚀🚀 today",
      lastMessageAt: new Date(),
    });

    expect(await searchIds(owner, "ÉCOLE")).toEqual([french]);
    expect(await searchIds(owner, "école")).toEqual([french]);
    // The same word with its accent typed as a separate combining mark.
    expect(await searchIds(owner, "e\u0301cole")).toEqual([french]);
    expect(await searchIds(owner, "ПРИВЕТ")).toEqual([russian]);
    expect(await searchIds(owner, "🚀🚀")).toEqual([emoji]);
  });

  test("finds a match older than the roster's whole first page, and pages by 20", async () => {
    const owner = await createUser();
    const bot = await createBot(owner);
    const start = Date.UTC(2026, 0, 1);
    const old = await conversation(owner, bot, {
      summary: "The archived needle",
      lastMessageAt: new Date(start),
    });
    for (let index = 1; index <= 59; index += 1) {
      await conversation(owner, bot, {
        summary: index <= 24 ? `Haystack needle ${index}` : `Haystack ${index}`,
        lastMessageAt: new Date(start + index * 60_000),
      });
    }

    const firstRosterPage = await store.list(owner);
    expect(firstRosterPage.channels).toHaveLength(50);
    expect(firstRosterPage.channels.map((row) => row.id)).not.toContain(old);

    const archived = await store.search(owner, { query: "archived needle" });
    expect(archived.channels.map((row) => row.id)).toEqual([old]);
    expect(archived.nextCursor).toBeNull();

    // 25 match: the default page holds 20 and says there is more.
    const first = await store.search(owner, { query: "needle" });
    expect(first.channels).toHaveLength(20);
    expect(first.nextCursor).toBeString();
    const rest = await store.search(owner, {
      query: "needle",
      cursor: first.nextCursor as string,
    });
    expect(rest.channels).toHaveLength(5);
    expect(rest.channels.at(-1)?.id).toBe(old);
    expect(rest.nextCursor).toBeNull();
  });

  test("pages ties on the whole sort key with every match once, pinned first", async () => {
    const owner = await createUser();
    const bot = await createBot(owner);
    // One instant for all of them, so only the pin and the id can order the rows.
    const same = new Date("2026-06-01T12:00:00.123456Z");
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      ids.push(
        await conversation(owner, bot, {
          summary: `Tied match ${index}`,
          lastMessageAt: same,
        }),
      );
    }
    const pinned = ids[3] as string;
    await store.setPinned(owner, pinned, true);

    for (const limit of [1, 2, 3]) {
      const rows = await everyPage(owner, "tied match", limit);
      const seen = rows.map((row) => row.id);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual([
        pinned,
        ...ids.filter((id) => id !== pinned).sort((a, b) => (a < b ? 1 : -1)),
      ]);
      expect(rows[0]?.pinned).toBe(true);
    }
  });

  test("answers each caller with their own conversations only", async () => {
    const owner = await createUser();
    const member = await createUser();
    const outsider = await createUser();
    // A public Bot, so anybody could talk to it; that does not make anybody's conversation theirs.
    const bot = await createBot(owner, "Shared Desk", "public");
    const ownersOnly = await conversation(owner, bot, {
      summary: "Payroll correction",
    });
    const shared = await conversation(owner, bot, {
      summary: "Payroll group review",
    });
    await join(member, shared);
    await store.setPinned(member, shared, true);
    const outsidersOwn = await conversation(outsider, bot, {
      summary: "Payroll for my team",
    });

    expect((await searchIds(owner, "payroll")).sort()).toEqual(
      [ownersOnly, shared].sort(),
    );
    const memberSees = await store.search(member, { query: "payroll" });
    expect(memberSees.channels.map((row) => row.id)).toEqual([shared]);
    // The member's own pin and thread, never the owner's.
    expect(memberSees.channels[0]?.pinned).toBe(true);
    const [mapping] = await database
      .select({ threadId: intelligenceChannelMappings.threadId })
      .from(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.userId, member.id));
    expect(memberSees.channels[0]?.threadId).toBe(mapping?.threadId as string);
    expect((await store.search(owner, { query: "payroll" })).channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: shared, pinned: false }),
      ]),
    );
    expect(await searchIds(outsider, "payroll")).toEqual([outsidersOwn]);
    // Matching by the Bot's name does not reach past membership either.
    expect(await searchIds(outsider, "shared desk")).toEqual([outsidersOwn]);

    const response = await appAs(outsider).request(
      "http://openbot.test/search?q=payroll",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { channels: { id: string }[] };
    expect(body.channels.map((row) => row.id)).toEqual([outsidersOwn]);
  });

  test("leaves deleted conversations out, and returns exactly what the roster would", async () => {
    const owner = await createUser();
    const bot = await createBot(owner, "Ledger");
    const retired = await createBot(owner, "Retired Ledger");
    const kept = await conversation(owner, bot, { summary: "Audit trail" });
    const deleted = await conversation(owner, bot, {
      summary: "Audit trail, deleted",
    });
    await store.softDelete(owner, deleted);
    const task = await conversation(owner, bot, {
      summary: "Audit trail task",
    });
    await database.insert(botTasks).values({
      id: randomUUID(),
      ownerUserId: owner.id,
      agentId: bot,
      channelId: task,
      title: "Audit trail task",
      origin: "check_in",
    });
    // A conversation whose Bot was deleted stays on the roster, readable and inactive, so search
    // finds it the same way.
    const orphaned = await conversation(owner, retired, {
      summary: "Audit trail from before",
    });
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, retired));

    const found = await store.search(owner, { query: "audit trail" });
    expect(found.channels.map((row) => row.id)).not.toContain(deleted);
    const roster = await store.list(owner);
    // Field for field the roster's rows, in the roster's order: one set of visibility rules.
    expect(found.channels).toEqual(
      roster.channels.filter((row) => [kept, task, orphaned].includes(row.id)),
    );
    expect(found.channels.find((row) => row.id === task)?.task).toBe(true);
    expect(found.channels.find((row) => row.id === orphaned)?.active).toBe(
      false,
    );
  });

  test("refuses a cursor from another search, at the store and at the route", async () => {
    const owner = await createUser();
    const bot = await createBot(owner);
    for (let index = 0; index < 3; index += 1) {
      await conversation(owner, bot, { summary: `Alpha beta ${index}` });
    }
    const first = await store.search(owner, { query: "alpha", limit: 1 });
    const cursor = first.nextCursor as string;
    expect(cursor).toBeString();

    await expect(
      store.search(owner, { query: "beta", cursor }),
    ).rejects.toThrow(ChannelSearchInputError);
    // The roster's own cursor is not a search cursor either.
    const rosterCursor = (await store.list(owner, { limit: 1 }))
      .nextCursor as string;
    await expect(
      store.search(owner, { query: "alpha", cursor: rosterCursor }),
    ).rejects.toThrow(SEARCH_CURSOR_ERROR);

    const app = appAs(owner);
    const refused = await app.request(
      `http://openbot.test/search?q=beta&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: SEARCH_CURSOR_ERROR });

    // The same search, typed with different spacing, is the same search.
    const next = await app.request(
      `http://openbot.test/search?q=${encodeURIComponent("  alpha ")}&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(next.status).toBe(200);
    const body = (await next.json()) as {
      channels: { id: string }[];
      nextCursor: string | null;
    };
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]?.id).not.toBe(first.channels[0]?.id);
  });
});
