import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, externalThreadMessages, users } from "../src/db/schema";
import {
  createExternalThreadStore,
  type ExternalThreadBindingInput,
  ExternalThreadConflictError,
} from "../src/external/thread-store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const store = createExternalThreadStore(database);
const suite = randomUUID().slice(0, 8);
const creatorId = `external_thread_creator_${suite}`;
const otherCreatorId = `external_thread_other_creator_${suite}`;
const paginationCreatorId = `external_thread_page_creator_${suite}`;
const accessFilterCreatorId = `external_thread_access_creator_${suite}`;
const previewCreatorId = `external_thread_preview_creator_${suite}`;
const foreignKeyCreatorId = `external_thread_fk_creator_${suite}`;
const riskAgentId = `external_thread_risk_${suite}`;
const knowledgeAgentId = `external_thread_knowledge_${suite}`;
const foreignKeyAgentId = `external_thread_fk_agent_${suite}`;

function encodeCursor(cursor: { recency: string; threadId: string }): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function binding(
  label: string,
  overrides: Partial<ExternalThreadBindingInput> = {},
): ExternalThreadBindingInput {
  return {
    channelsThreadId: `channels_${label}_${suite}`,
    provider: "slack",
    providerTenantId: `T${suite}`,
    providerConversationId: `C${label}_${suite}`,
    providerThreadId: `P${label}_${suite}`,
    agentId: riskAgentId,
    agentName: "Risk Analyst",
    createdByUserId: creatorId,
    ...overrides,
  };
}

function expectAssignedToRisk(error: unknown): void {
  expect(error).toBeInstanceOf(ExternalThreadConflictError);
  if (error instanceof ExternalThreadConflictError) {
    expect(error.agentName).toBe("Risk Analyst");
    expect(error.message).toBe(
      "This Slack thread is already assigned to Risk Analyst.",
    );
  }
}

async function concurrentBinds(
  left: ExternalThreadBindingInput,
  right: ExternalThreadBindingInput,
) {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot";
  const leftDatabase = createDatabase(databaseUrl, { max: 1 });
  const rightDatabase = createDatabase(databaseUrl, { max: 1 });
  try {
    return await Promise.allSettled([
      createExternalThreadStore(leftDatabase).bind(left),
      createExternalThreadStore(rightDatabase).bind(right),
    ]);
  } finally {
    await leftDatabase.$client.end();
    await rightDatabase.$client.end();
  }
}

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.code)
    ) {
      return candidate.code;
    }
    if (
      typeof candidate.errno === "string" &&
      /^[0-9A-Z]{5}$/.test(candidate.errno)
    ) {
      return candidate.errno;
    }
    current = candidate.cause;
  }
  return undefined;
}

function errorText(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { cause?: unknown; message?: unknown };
    if (typeof candidate.message === "string") messages.push(candidate.message);
    current = candidate.cause;
  }
  return messages.join("\n");
}

async function expectSqlState(
  work: () => Promise<unknown>,
  state: string,
): Promise<void> {
  const error = await work().catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(sqlState(error)).toBe(state);
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: creatorId, email: `${creatorId}@example.test` },
    { id: otherCreatorId, email: `${otherCreatorId}@example.test` },
    {
      id: paginationCreatorId,
      email: `${paginationCreatorId}@example.test`,
    },
    {
      id: accessFilterCreatorId,
      email: `${accessFilterCreatorId}@example.test`,
    },
    {
      id: previewCreatorId,
      email: `${previewCreatorId}@example.test`,
    },
    {
      id: foreignKeyCreatorId,
      email: `${foreignKeyCreatorId}@example.test`,
    },
  ]);
  await database.insert(agents).values([
    {
      id: riskAgentId,
      name: "Risk Analyst",
      type: "remote_ag_ui",
      configuration: {},
    },
    {
      id: knowledgeAgentId,
      name: "Knowledge Analyst",
      type: "remote_ag_ui",
      configuration: {},
    },
    {
      id: foreignKeyAgentId,
      name: "Foreign Key Analyst",
      type: "remote_ag_ui",
      configuration: {},
    },
  ]);
});

afterAll(async () => {
  /* The migration makes production rows append-only; test fixtures are removed only with the user
   * trigger temporarily disabled, after direct DELETE rejection has already been proved below. */
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`ALTER TABLE "external_thread_bindings" DISABLE TRIGGER USER`,
    );
    await transaction.execute(sql`
      DELETE FROM "external_thread_bindings"
      WHERE "created_by_user_id" IN (
        ${creatorId},
        ${otherCreatorId},
        ${paginationCreatorId},
        ${accessFilterCreatorId},
        ${previewCreatorId},
        ${foreignKeyCreatorId}
      )
    `);
    await transaction.execute(
      sql`ALTER TABLE "external_thread_bindings" ENABLE TRIGGER USER`,
    );
  });
  await database.delete(agents).where(eq(agents.id, riskAgentId));
  await database.delete(agents).where(eq(agents.id, knowledgeAgentId));
  await database.delete(agents).where(eq(agents.id, foreignKeyAgentId));
  await database.delete(users).where(eq(users.id, creatorId));
  await database.delete(users).where(eq(users.id, otherCreatorId));
  await database.delete(users).where(eq(users.id, paginationCreatorId));
  await database.delete(users).where(eq(users.id, accessFilterCreatorId));
  await database.delete(users).where(eq(users.id, previewCreatorId));
  await database.delete(users).where(eq(users.id, foreignKeyCreatorId));
  await database.$client.end();
});

describe("external thread bindings", () => {
  test("binds and reloads a canonical Channels thread id", async () => {
    const input = binding("canonical");
    const bound = await store.bind(input);

    await expect(
      store.getByChannelsThreadId(input.channelsThreadId),
    ).resolves.toEqual(bound);
  });

  test("appends provider-visible turns idempotently and reads them in order", async () => {
    const input = binding("transcript");
    await store.bind(input);
    const turn = {
      channelsThreadId: input.channelsThreadId,
      user: { id: "user-1", role: "user" as const, content: "Hello" },
      assistant: {
        id: "reply-1",
        role: "assistant" as const,
        content: "Hi there",
      },
    };

    await store.appendTranscriptTurn(turn);
    await store.appendTranscriptTurn(turn);

    await expect(store.getTranscript(input.channelsThreadId)).resolves.toEqual([
      turn.user,
      turn.assistant,
    ]);
  });

  test("lists only the creator's Slack threads with latest activity first", async () => {
    const older = binding("list_older");
    const newer = binding("list_newer");
    const foreign = binding("list_foreign", {
      createdByUserId: otherCreatorId,
    });
    await store.bind(older);
    await store.bind(newer);
    await store.bind(foreign);
    await database.insert(externalThreadMessages).values([
      {
        channelsThreadId: older.channelsThreadId,
        messageId: "older-user",
        role: "user",
        content: "old line",
        createdAt: new Date("2099-08-28T10:00:00.000Z"),
      },
      {
        channelsThreadId: newer.channelsThreadId,
        messageId: "newer-lower-sequence-later-time",
        role: "user",
        content: "wrong by timestamp",
        createdAt: new Date("2099-08-28T12:00:00.000Z"),
      },
      {
        channelsThreadId: newer.channelsThreadId,
        messageId: "newer-higher-sequence-earlier-time",
        role: "assistant",
        content: "newest\nline",
        createdAt: new Date("2099-08-28T11:00:00.000Z"),
      },
      {
        channelsThreadId: foreign.channelsThreadId,
        messageId: "foreign-user",
        role: "user",
        content: "must stay private",
        createdAt: new Date("2099-08-28T12:00:00.000Z"),
      },
    ]);

    const page = await store.listForCreator(creatorId, { limit: 20 });

    const listed = page.threads.filter((thread) =>
      [older.channelsThreadId, newer.channelsThreadId].includes(
        thread.threadId,
      ),
    );
    expect(listed.map((thread) => thread.threadId)).toEqual([
      newer.channelsThreadId,
      older.channelsThreadId,
    ]);
    expect(listed[0]?.lastMessage).toBe("newest line");
    expect(listed[0]?.lastMessageAt).toEqual(
      new Date("2099-08-28T11:00:00.000Z"),
    );
    expect(
      page.threads.some(
        (thread) => thread.threadId === foreign.channelsThreadId,
      ),
    ).toBe(false);
  });

  test("paginates Slack thread summaries with an opaque malformed-safe cursor", async () => {
    const first = binding("page_first", {
      createdByUserId: paginationCreatorId,
    });
    const second = binding("page_second", {
      createdByUserId: paginationCreatorId,
    });
    const third = binding("page_third", {
      createdByUserId: paginationCreatorId,
    });
    await store.bind(first);
    await store.bind(second);
    await store.bind(third);
    await database.insert(externalThreadMessages).values([
      {
        channelsThreadId: first.channelsThreadId,
        messageId: "page-first-user",
        role: "user",
        content: "first page first",
        createdAt: new Date("2099-08-29T13:00:00.000Z"),
      },
      {
        channelsThreadId: second.channelsThreadId,
        messageId: "page-second-user",
        role: "user",
        content: "first page second",
        createdAt: new Date("2099-08-29T12:00:00.000Z"),
      },
      {
        channelsThreadId: third.channelsThreadId,
        messageId: "page-third-user",
        role: "user",
        content: "second page",
        createdAt: new Date("2099-08-29T11:00:00.000Z"),
      },
    ]);

    const pageOne = await store.listForCreator(paginationCreatorId, {
      limit: 2,
    });
    const pageTwo = await store.listForCreator(paginationCreatorId, {
      limit: 2,
      cursor: pageOne.nextCursor ?? undefined,
    });
    const malformedCursorPage = await store.listForCreator(
      paginationCreatorId,
      {
        limit: 2,
        cursor: "malformed",
      },
    );

    expect(pageOne.threads.map((thread) => thread.threadId)).toEqual([
      first.channelsThreadId,
      second.channelsThreadId,
    ]);
    expect(pageOne.nextCursor).not.toBeNull();
    expect(pageTwo.threads.map((thread) => thread.threadId)).toEqual([
      third.channelsThreadId,
    ]);
    expect(
      new Set([
        ...pageOne.threads.map((thread) => thread.threadId),
        ...pageTwo.threads.map((thread) => thread.threadId),
      ]).size,
    ).toBe(pageOne.threads.length + pageTwo.threads.length);
    expect(
      malformedCursorPage.threads.map((thread) => thread.threadId),
    ).toEqual(pageOne.threads.map((thread) => thread.threadId));
  });

  test("filters allowed agent ids before applying the page limit", async () => {
    const allowed = binding("allowed_agent_before_limit", {
      createdByUserId: accessFilterCreatorId,
      agentId: riskAgentId,
      agentName: "Risk Analyst",
    });
    const blocked = binding("blocked_agent_before_limit", {
      createdByUserId: accessFilterCreatorId,
      agentId: knowledgeAgentId,
      agentName: "Knowledge Analyst",
    });
    await store.bind(allowed);
    await store.bind(blocked);
    await database.insert(externalThreadMessages).values([
      {
        channelsThreadId: blocked.channelsThreadId,
        messageId: "blocked-agent-before-limit-user",
        role: "user",
        content: "blocked newest",
        createdAt: new Date("2099-09-02T12:00:00.000Z"),
      },
      {
        channelsThreadId: allowed.channelsThreadId,
        messageId: "allowed-agent-before-limit-user",
        role: "user",
        content: "allowed older",
        createdAt: new Date("2099-09-02T11:00:00.000Z"),
      },
    ]);

    const page = await store.listForCreator(accessFilterCreatorId, {
      agentIds: [riskAgentId],
      limit: 1,
    });

    expect(page.threads.map((thread) => thread.threadId)).toEqual([
      allowed.channelsThreadId,
    ]);
    expect(page.nextCursor).toBeNull();
  });

  test("returns an empty page when the allowed agent id set is empty", async () => {
    const page = await store.listForCreator(accessFilterCreatorId, {
      agentIds: [],
      limit: 1,
    });

    expect(page).toEqual({ threads: [], nextCursor: null });
  });

  test("treats noncanonical parseable cursor dates as the first page", async () => {
    const first = binding("noncanonical_cursor_first", {
      createdByUserId: paginationCreatorId,
    });
    const second = binding("noncanonical_cursor_second", {
      createdByUserId: paginationCreatorId,
    });
    await store.bind(first);
    await store.bind(second);
    await database.insert(externalThreadMessages).values([
      {
        channelsThreadId: first.channelsThreadId,
        messageId: "noncanonical-cursor-first-user",
        role: "user",
        content: "first",
        createdAt: new Date("2099-08-30T12:00:00.000Z"),
      },
      {
        channelsThreadId: second.channelsThreadId,
        messageId: "noncanonical-cursor-second-user",
        role: "user",
        content: "second",
        createdAt: new Date("2099-08-30T11:00:00.000Z"),
      },
    ]);

    const firstPage = await store.listForCreator(paginationCreatorId, {
      limit: 2,
    });
    const tamperedPage = await store.listForCreator(paginationCreatorId, {
      limit: 2,
      cursor: encodeCursor({ recency: "0", threadId: first.channelsThreadId }),
    });

    expect(tamperedPage.threads.map((thread) => thread.threadId)).toEqual(
      firstPage.threads.map((thread) => thread.threadId),
    );
  });

  test("treats signed out-of-range cursor years as the first page", async () => {
    const first = binding("signed_cursor_first", {
      createdByUserId: paginationCreatorId,
    });
    const second = binding("signed_cursor_second", {
      createdByUserId: paginationCreatorId,
    });
    await store.bind(first);
    await store.bind(second);
    await database.insert(externalThreadMessages).values([
      {
        channelsThreadId: first.channelsThreadId,
        messageId: "signed-cursor-first-user",
        role: "user",
        content: "first",
        createdAt: new Date("2099-08-31T12:00:00.000Z"),
      },
      {
        channelsThreadId: second.channelsThreadId,
        messageId: "signed-cursor-second-user",
        role: "user",
        content: "second",
        createdAt: new Date("2099-08-31T11:00:00.000Z"),
      },
    ]);

    const firstPage = await store.listForCreator(paginationCreatorId, {
      limit: 2,
    });
    const tamperedPage = await store.listForCreator(paginationCreatorId, {
      limit: 2,
      cursor: encodeCursor({
        recency: "+275760-09-13T00:00:00.000Z",
        threadId: first.channelsThreadId,
      }),
    });

    expect(tamperedPage.threads.map((thread) => thread.threadId)).toEqual(
      firstPage.threads.map((thread) => thread.threadId),
    );
  });

  test("treats canonical year zero cursor dates as the first page", async () => {
    const first = binding("year_zero_cursor_first", {
      createdByUserId: paginationCreatorId,
    });
    const second = binding("year_zero_cursor_second", {
      createdByUserId: paginationCreatorId,
    });
    await store.bind(first);
    await store.bind(second);
    await database.insert(externalThreadMessages).values([
      {
        channelsThreadId: first.channelsThreadId,
        messageId: "year-zero-cursor-first-user",
        role: "user",
        content: "first",
        createdAt: new Date("2099-09-01T12:00:00.000Z"),
      },
      {
        channelsThreadId: second.channelsThreadId,
        messageId: "year-zero-cursor-second-user",
        role: "user",
        content: "second",
        createdAt: new Date("2099-09-01T11:00:00.000Z"),
      },
    ]);

    const firstPage = await store.listForCreator(paginationCreatorId, {
      limit: 2,
    });
    const tamperedPage = await store.listForCreator(paginationCreatorId, {
      limit: 2,
      cursor: encodeCursor({
        recency: "0000-01-01T00:00:00.000Z",
        threadId: first.channelsThreadId,
      }),
    });

    expect(tamperedPage.threads.map((thread) => thread.threadId)).toEqual(
      firstPage.threads.map((thread) => thread.threadId),
    );
  });

  test("uses binding creation as the activity fallback without transcript messages", async () => {
    const active = binding("activity_message", {
      createdByUserId: previewCreatorId,
    });
    const empty = binding("activity_empty", {
      createdByUserId: previewCreatorId,
    });
    await store.bind(active);
    await store.bind(empty);
    await database.insert(externalThreadMessages).values({
      channelsThreadId: active.channelsThreadId,
      messageId: "activity-message-user",
      role: "user",
      content: "older transcript activity",
      createdAt: new Date("2000-01-01T00:00:00.000Z"),
    });

    const page = await store.listForCreator(previewCreatorId, { limit: 10 });

    const listed = page.threads.filter((thread) =>
      [empty.channelsThreadId, active.channelsThreadId].includes(
        thread.threadId,
      ),
    );
    expect(listed.map((thread) => thread.threadId)).toEqual([
      empty.channelsThreadId,
      active.channelsThreadId,
    ]);
    expect(listed[0]).toMatchObject({
      threadId: empty.channelsThreadId,
      lastMessage: null,
      lastMessageAt: null,
    });
    expect(listed[0]?.createdAt).toBeInstanceOf(Date);
  });

  test("sanitizes Slack thread previews to a 200-code-point one-line cap", async () => {
    const input = binding("preview_cap", {
      createdByUserId: previewCreatorId,
    });
    await store.bind(input);
    await database.insert(externalThreadMessages).values({
      channelsThreadId: input.channelsThreadId,
      messageId: "preview-cap-user",
      role: "user",
      content: `Start\u0001\t\n${"💬".repeat(205)} tail`,
      createdAt: new Date("2099-08-30T10:00:00.000Z"),
    });

    const page = await store.listForCreator(previewCreatorId, { limit: 1 });

    const preview = page.threads[0]?.lastMessage;
    expect(preview).toBe(`Start ${"💬".repeat(193)}…`);
    expect(preview).not.toContain("\u0001");
    expect(preview).not.toContain("\n");
    expect(preview).not.toContain("\t");
    expect(Array.from(preview ?? "")).toHaveLength(200);
  });

  test("reloads a binding by its provider thread identity", async () => {
    const input = binding("provider_lookup");
    const bound = await store.bind(input);

    await expect(
      store.getByProviderThread({
        provider: input.provider,
        providerTenantId: input.providerTenantId,
        providerConversationId: input.providerConversationId,
        providerThreadId: input.providerThreadId,
      }),
    ).resolves.toEqual(bound);
  });

  test("makes the same binding idempotent", async () => {
    const input = binding("idempotent");
    const bound = await store.bind(input);

    await expect(store.bind(input)).resolves.toEqual(bound);
  });

  test("never switches an established thread to another agent", async () => {
    const input = binding("agent_immutable");
    await store.bind(input);

    const error = await store
      .bind({
        ...input,
        agentId: knowledgeAgentId,
        agentName: "Knowledge Analyst",
      })
      .catch((reason: unknown) => reason);

    expectAssignedToRisk(error);
  });

  test("does not let a provider thread create a second canonical binding", async () => {
    const input = binding("provider_unique");
    const first = await store.bind(input);

    const error = await store
      .bind({
        ...input,
        channelsThreadId: `channels_provider_unique_other_${suite}`,
        agentId: knowledgeAgentId,
        agentName: "Knowledge Analyst",
      })
      .catch((reason: unknown) => reason);

    expectAssignedToRisk(error);
    await expect(
      store.getByProviderThread({
        provider: input.provider,
        providerTenantId: input.providerTenantId,
        providerConversationId: input.providerConversationId,
        providerThreadId: input.providerThreadId,
      }),
    ).resolves.toEqual(first);
  });

  test("does not let a canonical thread replace its provider identity", async () => {
    const input = binding("channels_unique");
    const first = await store.bind(input);

    const error = await store
      .bind({
        ...input,
        providerConversationId: `Cchannels_unique_other_${suite}`,
        providerThreadId: `Pchannels_unique_other_${suite}`,
        agentId: knowledgeAgentId,
        agentName: "Knowledge Analyst",
      })
      .catch((reason: unknown) => reason);

    expectAssignedToRisk(error);
    await expect(
      store.getByChannelsThreadId(input.channelsThreadId),
    ).resolves.toEqual(first);
  });

  test("keeps the winner when first deliveries race", async () => {
    const input = binding("agent_race");
    const results = await concurrentBinds(input, {
      ...input,
      agentId: knowledgeAgentId,
      agentName: "Knowledge Analyst",
    });
    const [left, right] = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });

    expect(left.agentId).toBe(right.agentId);
    expect([riskAgentId, knowledgeAgentId]).toContain(left.agentId);
  });

  test("fails closed when concurrent calls cross provider identity", async () => {
    const input = binding("provider_race");
    const results = await concurrentBinds(input, {
      ...input,
      channelsThreadId: `channels_provider_race_other_${suite}`,
    });

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  test("fails closed when concurrent calls cross canonical identity", async () => {
    const input = binding("canonical_race");
    const results = await concurrentBinds(input, {
      ...input,
      providerConversationId: `Ccanonical_race_other_${suite}`,
      providerThreadId: `Pcanonical_race_other_${suite}`,
    });

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  test("fails closed when first deliveries disagree on the creator", async () => {
    const input = binding("creator_race");
    const results = await concurrentBinds(input, {
      ...input,
      createdByUserId: otherCreatorId,
    });

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  test("refuses two crossed durable identities instead of choosing one", async () => {
    const canonical = binding("crossed_canonical");
    const provider = binding("crossed_provider");
    await store.bind(canonical);
    await store.bind(provider);

    const error = await store
      .bind({
        ...canonical,
        providerConversationId: provider.providerConversationId,
        providerThreadId: provider.providerThreadId,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe(
        "External thread bindings have conflicting identities.",
      );
    }
  });

  test("returns the current agent profile name rather than a duplicate binding name", async () => {
    const input = binding("current_name");
    await store.bind(input);
    await database
      .update(agents)
      .set({ name: "Renamed Risk Analyst" })
      .where(eq(agents.id, riskAgentId));

    await expect(
      store.getByChannelsThreadId(input.channelsThreadId),
    ).resolves.toMatchObject({ agentName: "Renamed Risk Analyst" });

    await database
      .update(agents)
      .set({ name: "Risk Analyst" })
      .where(eq(agents.id, riskAgentId));
  });

  test("restricts deletion of the binding's agent and creator", async () => {
    const input = binding("restrict", {
      agentId: foreignKeyAgentId,
      agentName: "Foreign Key Analyst",
      createdByUserId: foreignKeyCreatorId,
    });
    await store.bind(input);

    const agentError = await Promise.resolve(
      database.delete(agents).where(eq(agents.id, foreignKeyAgentId)),
    ).catch((reason: unknown) => reason);
    expect(sqlState(agentError)).toBe("23503");
    expect(errorText(agentError)).toContain(
      "external_thread_bindings_agent_id_agents_id_fk",
    );

    const userError = await Promise.resolve(
      database.delete(users).where(eq(users.id, foreignKeyCreatorId)),
    ).catch((reason: unknown) => reason);
    expect(sqlState(userError)).toBe("23503");
    expect(errorText(userError)).toContain(
      "external_thread_bindings_created_by_user_id_users_id_fk",
    );
  });

  test("the database refuses updates and deletes of bindings", async () => {
    const input = binding("append_only");
    await store.bind(input);

    await expectSqlState(
      () =>
        Promise.resolve(
          database.execute(
            sql`UPDATE "external_thread_bindings" SET "agent_id" = ${knowledgeAgentId} WHERE "channels_thread_id" = ${input.channelsThreadId}`,
          ),
        ),
      "P0001",
    );
    await expectSqlState(
      () =>
        Promise.resolve(
          database.execute(
            sql`DELETE FROM "external_thread_bindings" WHERE "channels_thread_id" = ${input.channelsThreadId}`,
          ),
        ),
      "P0001",
    );
  });

  test("the database refuses a provider other than Slack", async () => {
    const input = binding("provider_check");

    await expectSqlState(
      () =>
        Promise.resolve(
          database.execute(
            sql`INSERT INTO "external_thread_bindings" ("channels_thread_id", "provider", "provider_tenant_id", "provider_conversation_id", "provider_thread_id", "agent_id", "created_by_user_id") VALUES (${input.channelsThreadId}, 'discord', ${input.providerTenantId}, ${input.providerConversationId}, ${input.providerThreadId}, ${input.agentId}, ${input.createdByUserId})`,
          ),
        ),
      "23514",
    );
  });
});
