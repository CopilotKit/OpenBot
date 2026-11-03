import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { writeKey } from "../src/conversations/http";
import type { ConversationDraft } from "../src/conversations/types";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  proactivePeople,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { createTaskStore } from "../src/tasks/store";
import { removeBots, seedBot } from "./support/bots";
import {
  conversationClient,
  maybeConversation,
  newThreadId,
  purgeConversations,
  storedTask,
} from "./support/conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The database half of check-ins: the backstops that hold when two replicas race, which no code
 * path can promise on its own. Each test drives the real tables through real SQL, and a task's
 * backstops, which live with the task in Intelligence now, through the real Intelligence.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `proactive-schema-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
let counter = 0;
const next = () => `${prefix}-${counter++}`;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  let message = "";
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    message = `${String(error)} ${String(cause ?? "")} ${JSON.stringify(error)}`;
  }
  expect(message).toMatch(pattern);
}

async function setting() {
  const id = next();
  await database.insert(proactiveSettings).values({
    id,
    ownerUserId: owner,
    agentId: bot,
    channelId: next(),
    threadId: next(),
  });
  return id;
}

let settingId = "";
beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await seedBot({ id: bot, name: "Inbox Bot", type: "built_in" });
  settingId = await setting();
});

afterAll(async () => {
  await removeBots([bot]);
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

function item(
  overrides: Partial<typeof proactiveSuggestions.$inferInsert> = {},
) {
  return {
    id: next(),
    ownerUserId: owner,
    agentId: bot,
    settingId,
    runId: next(),
    title: "Reply to Dana about Friday",
    detail: "Dana asked whether Friday still works.",
    sourceApp: "Gmail",
    sourceRef: "gmail.read",
    ...overrides,
  };
}

test("a new setting checks in hourly unless the person chooses otherwise", async () => {
  const [row] = await database
    .select({ interval: proactiveSettings.intervalMinutes })
    .from(proactiveSettings)
    .where(eq(proactiveSettings.id, settingId));
  expect(row?.interval).toBe(60);
});

test("two open items with one normalized title cannot both stand for a person and Bot", async () => {
  // The race two check-ins can lose: both pass the repeat check, and only one insert may land.
  const dedupeKey = `reply to dana about friday ${next()}`;
  const first = item({ dedupeKey });
  await database.insert(proactiveSuggestions).values(first);
  await rejects(
    database.insert(proactiveSuggestions).values(item({ dedupeKey })),
    /proactive_suggestions_open_dedupe_idx/,
  );
  // Once the person hid the first, the index no longer holds it; the 30-day rule is the engine's.
  await database
    .update(proactiveSuggestions)
    .set({ status: "dismissed", resolvedAt: new Date() })
    .where(eq(proactiveSuggestions.id, first.id));
  await database.insert(proactiveSuggestions).values(item({ dedupeKey }));
  // Items from before the key existed are never refused by it.
  await database.insert(proactiveSuggestions).values([item(), item()]);
});

test("one check-in runs at a time per setting, and only a skipped one carries a reason", async () => {
  const own = settingId;
  const run = (overrides: Partial<typeof proactiveRuns.$inferInsert> = {}) => ({
    id: next(),
    settingId: own,
    ownerUserId: owner,
    agentId: bot,
    trigger: "schedule" as const,
    ...overrides,
  });
  const running = run({ threadId: next() });
  await database.insert(proactiveRuns).values(running);
  // A second replica, or Run now, finds the first still running.
  await rejects(
    database.insert(proactiveRuns).values(run({ trigger: "run_now" })),
    /proactive_runs_one_running_idx/,
  );
  await database
    .update(proactiveRuns)
    .set({ outcome: "quiet", finishedAt: new Date() })
    .where(eq(proactiveRuns.id, running.id));
  await database.insert(proactiveRuns).values(run());

  const finished = new Date();
  await database
    .insert(proactiveRuns)
    .values(
      run({ outcome: "skipped", skipReason: "capped", finishedAt: finished }),
    );
  await rejects(
    database
      .insert(proactiveRuns)
      .values(run({ outcome: "skipped", finishedAt: finished })),
    /proactive_runs_skip_reason_check/,
  );
  await rejects(
    database
      .insert(proactiveRuns)
      .values(
        run({ outcome: "failed", skipReason: "busy", finishedAt: finished }),
      ),
    /proactive_runs_skip_reason_check/,
  );
  // A finished outcome has a finish time; a running one does not.
  await rejects(
    database.insert(proactiveRuns).values(run({ outcome: "raised" })),
    /proactive_runs_finished_check/,
  );
});

test("a ping is the person's, and its items outlive it", async () => {
  const ping = {
    id: next(),
    ownerUserId: owner,
    text: "1 thing needs you",
    pushBody: "One thing needs you",
  };
  await rejects(
    database.insert(proactivePings).values({ ...ping, itemCount: 0 }),
    /proactive_pings_item_count_check/,
  );
  await database.insert(proactivePings).values({ ...ping, itemCount: 1 });
  const carried = item({ pingId: ping.id, deliveredAt: new Date() });
  await database.insert(proactiveSuggestions).values(carried);
  await database.delete(proactivePings).where(eq(proactivePings.id, ping.id));
  const [row] = await database
    .select({
      pingId: proactiveSuggestions.pingId,
      status: proactiveSuggestions.status,
    })
    .from(proactiveSuggestions)
    .where(eq(proactiveSuggestions.id, carried.id));
  expect(row).toEqual({ pingId: null, status: "open" });

  // One hourly slot per person, gone with them.
  const person = next();
  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test` });
  await database.insert(proactivePeople).values({ ownerUserId: person });
  await rejects(
    database.insert(proactivePeople).values({ ownerUserId: person }),
    /proactive_people_pkey/,
  );
  await database.delete(users).where(eq(users.id, person));
  expect(
    await database
      .select()
      .from(proactivePeople)
      .where(eq(proactivePeople.ownerUserId, person)),
  ).toEqual([]);
});

test("starting an item opens one task, in a conversation of its own", async () => {
  const started = item({ status: "started", resolvedAt: new Date() });
  await database.insert(proactiveSuggestions).values(started);
  const [first, second] = [`channel_${next()}`, `channel_${next()}`];
  const draft = (id: string): ConversationDraft => ({
    id,
    name: "Reply to Dana",
    description: "",
    agents: [{ agentId: bot }],
    members: [{ userId: owner, threadId: newThreadId() }],
  });
  const store = createTaskStore(database);
  const task = {
    ownerUserId: owner,
    agentId: bot,
    suggestionId: started.id,
    title: started.title,
    why: started.detail,
    origin: "check_in" as const,
    sourceApp: null,
    sourceLink: null,
  };
  const client = await conversationClient();
  try {
    const opened = await store.create(task, draft(first));
    expect(opened.channelId).toBe(first);
    // A second Start of the same item finds the first task, and makes no conversation for it.
    expect(await store.create(task, draft(second))).toEqual(opened);
    expect(await maybeConversation(second)).toBeNull();
    // A conversation holds one task.
    await rejects(
      client.tasks.create(
        {
          id: next(),
          userId: owner,
          agentId: bot,
          conversationId: first,
          originRef: null,
          origin: "check_in",
          title: started.title,
          why: started.detail,
          sourceApp: null,
          sourceLink: null,
        },
        writeKey("test.task"),
      ),
      /409 AGENT_TASK_CONVERSATION_TAKEN/,
    );
    // An origin Intelligence cannot hold is refused; what OpenBot opens is a check-in's.
    await rejects(
      client.tasks.create(
        {
          id: next(),
          userId: owner,
          agentId: bot,
          conversation: draft(second),
          originRef: null,
          origin: "",
          title: started.title,
          why: started.detail,
          sourceApp: null,
          sourceLink: null,
        },
        writeKey("test.task"),
      ),
      /400/,
    );
    expect(await maybeConversation(second)).toBeNull();
    expect((await storedTask(opened.id))?.origin).toBe("check_in");
    // The item going away leaves its task, and its conversation, where they were.
    await database
      .delete(proactiveSuggestions)
      .where(eq(proactiveSuggestions.id, started.id));
    expect(await storedTask(opened.id)).toMatchObject({
      id: opened.id,
      conversationId: first,
      originRef: started.id,
    });
    expect((await maybeConversation(first))?.taskId).toBe(opened.id);
  } finally {
    await purgeConversations([first, second]);
  }
});
