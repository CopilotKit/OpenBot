import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agents,
  externalThreadBindings,
  externalThreadMessages,
} from "../db/schema";

export type ExternalTranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type ExternalThreadBindingInput = {
  channelsThreadId: string;
  provider: "slack";
  providerTenantId: string;
  providerConversationId: string;
  providerThreadId: string;
  agentId: string;
  /** Required by the public contract, but never trusted or persisted. Reads join the current name. */
  agentName: string;
  createdByUserId: string;
};

export type ExternalThreadBinding = Omit<
  ExternalThreadBindingInput,
  "agentName"
> & {
  agentName: string;
  createdAt: Date;
};

export type ExternalThreadSummary = {
  threadId: string;
  provider: "slack";
  agentId: string;
  agentName: string;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
};

export type ExternalThreadPage = {
  threads: ExternalThreadSummary[];
  nextCursor: string | null;
};

export type ExternalThreadListQuery = {
  agentIds?: readonly string[];
  cursor?: string;
  limit?: number;
};

/** An established Slack thread cannot be switched to another coworker. */
export class ExternalThreadConflictError extends Error {
  readonly agentName: string;

  constructor(agentName: string) {
    super(`This Slack thread is already assigned to ${agentName}.`);
    this.name = "ExternalThreadConflictError";
    this.agentName = agentName;
  }
}

export type ExternalThreadStore = {
  listForCreator: (
    creatorId: string,
    query?: ExternalThreadListQuery,
  ) => Promise<ExternalThreadPage>;
  getByChannelsThreadId: (id: string) => Promise<ExternalThreadBinding | null>;
  getByProviderThread: (
    identity: Pick<
      ExternalThreadBindingInput,
      | "provider"
      | "providerTenantId"
      | "providerConversationId"
      | "providerThreadId"
    >,
  ) => Promise<ExternalThreadBinding | null>;
  bind: (input: ExternalThreadBindingInput) => Promise<ExternalThreadBinding>;
  appendTranscriptTurn: (input: {
    channelsThreadId: string;
    user: ExternalTranscriptMessage & { role: "user" };
    assistant: ExternalTranscriptMessage & { role: "assistant" };
  }) => Promise<void>;
  getTranscript: (id: string) => Promise<ExternalTranscriptMessage[]>;
};

type BindingReader = Pick<Database, "select">;
type BindingWriter = BindingReader & Pick<Database, "insert">;

const bindingColumns = {
  channelsThreadId: externalThreadBindings.channelsThreadId,
  provider: externalThreadBindings.provider,
  providerTenantId: externalThreadBindings.providerTenantId,
  providerConversationId: externalThreadBindings.providerConversationId,
  providerThreadId: externalThreadBindings.providerThreadId,
  agentId: externalThreadBindings.agentId,
  agentName: agents.name,
  createdByUserId: externalThreadBindings.createdByUserId,
  createdAt: externalThreadBindings.createdAt,
};

const DEFAULT_EXTERNAL_THREAD_PAGE = 50;
const MAX_EXTERNAL_THREAD_PAGE = 200;
const MAX_PREVIEW_CODE_POINTS = 200;

type ExternalThreadCursor = { recency: string; threadId: string };

const latestMessageAt = sql<Date | null>`(
  select ${externalThreadMessages.createdAt}
  from ${externalThreadMessages}
  where ${externalThreadMessages.channelsThreadId} = ${externalThreadBindings.channelsThreadId}
  order by ${externalThreadMessages.sequence} desc
  limit 1
)`;
const latestMessageContent = sql<string | null>`(
  select ${externalThreadMessages.content}
  from ${externalThreadMessages}
  where ${externalThreadMessages.channelsThreadId} = ${externalThreadBindings.channelsThreadId}
  order by ${externalThreadMessages.sequence} desc
  limit 1
)`;
const externalRecency = sql<Date>`coalesce(${latestMessageAt}, ${externalThreadBindings.createdAt})`;

function asBinding(
  row: Omit<ExternalThreadBinding, "provider"> & { provider: string },
): ExternalThreadBinding {
  if (row.provider !== "slack") {
    throw new Error("External thread binding has an unsupported provider.");
  }
  return { ...row, provider: "slack" };
}

function isSameBinding(
  binding: ExternalThreadBinding,
  input: ExternalThreadBindingInput,
): boolean {
  return (
    binding.channelsThreadId === input.channelsThreadId &&
    binding.provider === input.provider &&
    binding.providerTenantId === input.providerTenantId &&
    binding.providerConversationId === input.providerConversationId &&
    binding.providerThreadId === input.providerThreadId &&
    binding.agentId === input.agentId &&
    binding.createdByUserId === input.createdByUserId
  );
}

function hasSameIdentityAndCreator(
  binding: ExternalThreadBinding,
  input: ExternalThreadBindingInput,
): boolean {
  return (
    binding.channelsThreadId === input.channelsThreadId &&
    binding.provider === input.provider &&
    binding.providerTenantId === input.providerTenantId &&
    binding.providerConversationId === input.providerConversationId &&
    binding.providerThreadId === input.providerThreadId &&
    binding.createdByUserId === input.createdByUserId
  );
}

function assignedError(
  binding: ExternalThreadBinding,
): ExternalThreadConflictError {
  return new ExternalThreadConflictError(binding.agentName);
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

function integrityError(): Error {
  return new Error("External thread bindings have conflicting identities.");
}

function encodeExternalThreadCursor(cursor: ExternalThreadCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeExternalThreadCursor(
  value: string | undefined,
): ExternalThreadCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as ExternalThreadCursor;
    if (
      typeof parsed?.recency !== "string" ||
      !/^\d{4}-/.test(parsed.recency) ||
      typeof parsed?.threadId !== "string"
    ) {
      return undefined;
    }
    const year = Number(parsed.recency.slice(0, 4));
    if (year < 1) return undefined;
    const recency = new Date(parsed.recency);
    if (
      Number.isNaN(recency.getTime()) ||
      recency.toISOString() !== parsed.recency
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function previewOf(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const flattened = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= MAX_PREVIEW_CODE_POINTS) return collapsed;
  return `${codePoints.slice(0, MAX_PREVIEW_CODE_POINTS - 1).join("")}\u2026`;
}

export function createExternalThreadStore(
  database: Database,
): ExternalThreadStore {
  async function listForCreator(
    creatorId: string,
    query: ExternalThreadListQuery = {},
  ): Promise<ExternalThreadPage> {
    if (query.agentIds?.length === 0) {
      return { threads: [], nextCursor: null };
    }

    const limit = Math.min(
      Math.max(query.limit ?? DEFAULT_EXTERNAL_THREAD_PAGE, 1),
      MAX_EXTERNAL_THREAD_PAGE,
    );
    const cursor = decodeExternalThreadCursor(query.cursor);
    const rows = await database
      .select({
        threadId: externalThreadBindings.channelsThreadId,
        agentId: externalThreadBindings.agentId,
        agentName: agents.name,
        lastMessage: latestMessageContent,
        lastMessageAt: latestMessageAt,
        createdAt: externalThreadBindings.createdAt,
        recency: externalRecency,
      })
      .from(externalThreadBindings)
      .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
      .where(
        and(
          eq(externalThreadBindings.createdByUserId, creatorId),
          query.agentIds
            ? inArray(externalThreadBindings.agentId, query.agentIds)
            : undefined,
          cursor
            ? sql`(${externalRecency}, ${externalThreadBindings.channelsThreadId}) < (${cursor.recency}::timestamptz, ${cursor.threadId})`
            : undefined,
        ),
      )
      .orderBy(
        sql`${externalRecency} desc`,
        desc(externalThreadBindings.channelsThreadId),
      )
      .limit(limit + 1);

    const wanted = rows.slice(0, limit);
    const last = wanted.at(-1);
    return {
      threads: wanted.map((row) => ({
        threadId: row.threadId,
        provider: "slack" as const,
        agentId: row.agentId,
        agentName: row.agentName,
        lastMessage:
          row.lastMessage === null ? null : previewOf(row.lastMessage),
        lastMessageAt: row.lastMessageAt,
        createdAt: row.createdAt,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeExternalThreadCursor({
              recency: new Date(last.recency).toISOString(),
              threadId: last.threadId,
            })
          : null,
    };
  }

  async function lookup(
    reader: BindingReader,
    input: Pick<
      ExternalThreadBindingInput,
      | "channelsThreadId"
      | "provider"
      | "providerTenantId"
      | "providerConversationId"
      | "providerThreadId"
    >,
  ): Promise<ExternalThreadBinding[]> {
    const rows = await reader
      .select(bindingColumns)
      .from(externalThreadBindings)
      .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
      .where(
        or(
          eq(externalThreadBindings.channelsThreadId, input.channelsThreadId),
          and(
            eq(externalThreadBindings.provider, input.provider),
            eq(externalThreadBindings.providerTenantId, input.providerTenantId),
            eq(
              externalThreadBindings.providerConversationId,
              input.providerConversationId,
            ),
            eq(externalThreadBindings.providerThreadId, input.providerThreadId),
          ),
        ),
      )
      .limit(2);
    return rows.map(asBinding);
  }

  function oneOrIntegrity(
    bindings: ExternalThreadBinding[],
  ): ExternalThreadBinding | null {
    if (bindings.length > 1) throw integrityError();
    return bindings[0] ?? null;
  }

  async function getByChannelsThreadId(
    id: string,
  ): Promise<ExternalThreadBinding | null> {
    const rows = await database
      .select(bindingColumns)
      .from(externalThreadBindings)
      .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
      .where(eq(externalThreadBindings.channelsThreadId, id))
      .limit(1);
    return rows[0] ? asBinding(rows[0]) : null;
  }

  async function getByProviderThread(
    identity: Pick<
      ExternalThreadBindingInput,
      | "provider"
      | "providerTenantId"
      | "providerConversationId"
      | "providerThreadId"
    >,
  ): Promise<ExternalThreadBinding | null> {
    const rows = await database
      .select(bindingColumns)
      .from(externalThreadBindings)
      .innerJoin(agents, eq(externalThreadBindings.agentId, agents.id))
      .where(
        and(
          eq(externalThreadBindings.provider, identity.provider),
          eq(
            externalThreadBindings.providerTenantId,
            identity.providerTenantId,
          ),
          eq(
            externalThreadBindings.providerConversationId,
            identity.providerConversationId,
          ),
          eq(
            externalThreadBindings.providerThreadId,
            identity.providerThreadId,
          ),
        ),
      )
      .limit(1);
    return rows[0] ? asBinding(rows[0]) : null;
  }

  async function bindInSerializableTransaction(
    input: ExternalThreadBindingInput,
  ): Promise<ExternalThreadBinding> {
    return database.transaction(
      async (transaction) => {
        const existing = oneOrIntegrity(await lookup(transaction, input));
        if (existing) {
          if (isSameBinding(existing, input)) return existing;
          throw assignedError(existing);
        }

        const [inserted] = await (transaction as BindingWriter)
          .insert(externalThreadBindings)
          .values({
            channelsThreadId: input.channelsThreadId,
            provider: input.provider,
            providerTenantId: input.providerTenantId,
            providerConversationId: input.providerConversationId,
            providerThreadId: input.providerThreadId,
            agentId: input.agentId,
            createdByUserId: input.createdByUserId,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          throw new Error("External thread binding was not inserted.");
        }

        const binding = oneOrIntegrity(await lookup(transaction, input));
        if (!binding) {
          throw new Error(
            "External thread binding was not found after insertion.",
          );
        }
        return binding;
      },
      { isolationLevel: "serializable" },
    );
  }

  async function bind(
    input: ExternalThreadBindingInput,
  ): Promise<ExternalThreadBinding> {
    try {
      return await bindInSerializableTransaction(input);
    } catch (error) {
      if (sqlState(error) !== "40001") throw error;

      /*
       * An overlapping, still-uncommitted first delivery is concurrency: both serializable snapshots
       * may see no binding, and one may lose validation. After rollback, one combined read sees the
       * committed winner. Only the exact canonical/provider identity and creator may converge; a
       * call that starts after the winner commits sees an established row and takes the conflict path.
       */
      const winner = oneOrIntegrity(await lookup(database, input));
      if (winner && hasSameIdentityAndCreator(winner, input)) return winner;
      if (winner) throw assignedError(winner);
      throw error;
    }
  }

  async function appendTranscriptTurn(input: {
    channelsThreadId: string;
    user: ExternalTranscriptMessage & { role: "user" };
    assistant: ExternalTranscriptMessage & { role: "assistant" };
  }): Promise<void> {
    await database
      .insert(externalThreadMessages)
      .values(
        [input.user, input.assistant].map((message) => ({
          channelsThreadId: input.channelsThreadId,
          messageId: message.id,
          role: message.role,
          content: message.content,
        })),
      )
      .onConflictDoNothing();
  }

  async function getTranscript(
    id: string,
  ): Promise<ExternalTranscriptMessage[]> {
    const rows = await database
      .select({
        id: externalThreadMessages.messageId,
        role: externalThreadMessages.role,
        content: externalThreadMessages.content,
      })
      .from(externalThreadMessages)
      .where(eq(externalThreadMessages.channelsThreadId, id))
      .orderBy(asc(externalThreadMessages.sequence));
    return rows.flatMap((row) =>
      row.role === "user" || row.role === "assistant"
        ? [{ ...row, role: row.role }]
        : [],
    );
  }

  return {
    listForCreator,
    getByChannelsThreadId,
    getByProviderThread,
    bind,
    appendTranscriptTurn,
    getTranscript,
  };
}
