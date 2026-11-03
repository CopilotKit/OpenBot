/**
 * Moving an existing deployment's conversations into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds its conversations in `channels`,
 * `channel_memberships`, `channel_agents`, `intelligence_channel_mappings` and `group_bot_threads`, a
 * group's shared transcript in `group_messages`, spoken conversations in `voice_sessions` and tasks in
 * `bot_tasks`. This copies all of it into Intelligence's conversations capability, deleted
 * conversations included (their history stays readable), with the ids, threads, pins, read markers
 * and timestamps they had. Every item Intelligence answers for is counted, and only when every local
 * row is accounted for (made now, or already there) is the copy recorded as done, so it never runs
 * again: a conversation later purged in Intelligence must not come back from the rows this release
 * keeps.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. Intelligence's import makes
 * only what it does not hold and never changes what it does, and each batch is sent under a key made
 * from its contents, so two replicas copying the same rows send the same request.
 *
 * LOUD ON A MISMATCH. An item Intelligence refuses stops the boot with the ids named: running on with
 * some conversations copied and some not would show people a roster with holes and nothing saying why.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  botTasks,
  channelAgents,
  channelMemberships,
  channels,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings,
  intelligenceCopies,
  voiceSessions,
} from "../db/schema";
import { type ConversationClient, draftToWire } from "./client";
import type { ConversationDraft, ImportResult } from "./types";

export const CONVERSATION_COPY_NAME = "conversations";

export class ConversationCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationCopyMismatchError";
  }
}

export type ConversationCopyOutcome =
  | { kind: "done-before" }
  | {
      kind: "copied";
      conversations: number;
      messages: number;
      voiceSessions: number;
      tasks: number;
      created: number;
    };

const BATCH = 100;
/**
 * The most one batch may weigh, serialised. Intelligence refuses a body over 2 MB, and a group's
 * lines and a voice session's transcript can be long, so a batch is cut by size as well as count.
 */
const BATCH_BYTES = 1_000_000;

/** Items in order, cut into batches of at most {@link BATCH} items and {@link BATCH_BYTES}. */
function batches<T>(items: T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (
      current.length > 0 &&
      (current.length >= BATCH || bytes + size > BATCH_BYTES)
    ) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function batchKey(resource: string, items: unknown[]): string {
  return `openbot-upgrade:${resource}:${createHash("sha256").update(JSON.stringify(items)).digest("hex")}`;
}

/** Send every item in batches, and account for each one: made now, already there, or refused. */
async function importAll<T>(
  resource: string,
  items: T[],
  send: (batch: T[], key: string) => Promise<ImportResult[]>,
  idOf: (item: T) => string,
): Promise<{ created: number; present: number }> {
  let created = 0;
  let present = 0;
  const refused: string[] = [];
  const missing: string[] = [];
  for (const batch of batches(items)) {
    const results = await send(batch, batchKey(resource, batch));
    const byId = new Map(results.map((result) => [result.id, result]));
    for (const item of batch) {
      const result = byId.get(idOf(item));
      if (!result) missing.push(idOf(item));
      else if (result.status === "created") {
        created += 1;
        present += 1;
      } else if (result.status === "exists") present += 1;
      else
        refused.push(
          `${idOf(item)}: ${result.error?.code ?? "refused"} ${result.error?.message ?? ""}`.trim(),
        );
    }
  }
  if (refused.length > 0 || missing.length > 0) {
    throw new ConversationCopyMismatchError(
      `${items.length} ${resource} were to be copied into Intelligence and ${present} are there.` +
        (refused.length > 0
          ? ` Refused:\n${refused.slice(0, 50).join("\n")}`
          : "") +
        (missing.length > 0
          ? ` Not answered for: ${missing.slice(0, 50).join(", ")}`
          : ""),
    );
  }
  return { created, present };
}

export async function copyLocalConversationsToIntelligence(
  database: Database,
  client: ConversationClient,
): Promise<ConversationCopyOutcome> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, CONVERSATION_COPY_NAME))
    .limit(1);
  if (done) return { kind: "done-before" };

  const [channelRows, memberRows, agentRows, mappingRows, groupThreadRows] =
    await Promise.all([
      database.select().from(channels),
      database.select().from(channelMemberships),
      database.select().from(channelAgents),
      database.select().from(intelligenceChannelMappings),
      database.select().from(groupBotThreads),
    ]);

  const by = <Row>(rows: Row[], key: (row: Row) => string) => {
    const grouped = new Map<string, Row[]>();
    for (const row of rows) {
      const list = grouped.get(key(row)) ?? [];
      list.push(row);
      grouped.set(key(row), list);
    }
    return grouped;
  };
  const membersOf = by(memberRows, (row) => row.channelId);
  const agentsOf = by(agentRows, (row) => row.channelId);
  const mappingsOf = by(mappingRows, (row) => row.channelId);
  const groupThreadsOf = by(groupThreadRows, (row) => row.channelId);

  const unmapped: string[] = [];
  const drafts: ConversationDraft[] = channelRows.map((channel) => {
    const members = membersOf.get(channel.id) ?? [];
    const memberIds = new Set(members.map((member) => member.userId));
    const threadOf = new Map(
      (mappingsOf.get(channel.id) ?? []).map((mapping) => [
        mapping.userId,
        mapping.threadId,
      ]),
    );
    // A thread mapped for somebody who is not a member was shown to nobody: noted, not copied.
    for (const userId of threadOf.keys())
      if (!memberIds.has(userId)) unmapped.push(`${channel.id}/${userId}`);
    return {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      suggestedPrompts: channel.suggestedPrompts,
      allowedGroups: channel.allowedGroups,
      managedBy: channel.packageId,
      agents: (agentsOf.get(channel.id) ?? []).map((agent) => ({
        agentId: agent.agentId,
        addedAt: agent.createdAt,
      })),
      members: members.map((member) => ({
        userId: member.userId,
        ...(threadOf.has(member.userId)
          ? { threadId: threadOf.get(member.userId) }
          : {}),
        joinedAt: member.createdAt,
        pinnedAt: member.pinnedAt,
        lastReadAt: member.lastReadAt,
      })),
      threads: (groupThreadsOf.get(channel.id) ?? []).map((thread) => ({
        userId: thread.ownerUserId,
        agentId: thread.agentId,
        threadId: thread.threadId,
        createdAt: thread.createdAt,
      })),
      createdAt: channel.createdAt,
      deletedAt: channel.deletedAt,
      summary: channel.summary,
      summaryAt: channel.summaryAt,
      lastMessage: channel.lastMessage,
      lastMessageSourceId: channel.lastMessageSourceId,
      lastMessageAt: channel.lastMessageAt,
      lastMessageAgentId: channel.lastMessageAgentId,
    };
  });
  if (unmapped.length > 0) {
    console.warn(
      JSON.stringify({
        type: "conversation-copy-skipped-unmapped-threads",
        note: "These threads were mapped for people who were not members, were shown to nobody, and are not copied.",
        threads: unmapped.slice(0, 100),
      }),
    );
  }

  const conversations = await importAll(
    "conversations",
    drafts,
    (batch, key) => client.import(batch, key),
    (draft) => draft.id,
  );
  // Read back, as the Bot copy does: every conversation copied is one Intelligence holds.
  const held = new Set(
    (await client.many(drafts.map((draft) => draft.id))).map(
      (conversation) => conversation.id,
    ),
  );
  const absent = drafts.filter((draft) => !held.has(draft.id));
  if (absent.length > 0) {
    throw new ConversationCopyMismatchError(
      `${drafts.length} conversations were to be copied into Intelligence and ${drafts.length - absent.length} are there. Missing: ${absent
        .slice(0, 50)
        .map((draft) => draft.id)
        .join(", ")}`,
    );
  }

  const messageRows = await database.select().from(groupMessages);
  const messages = await importAll(
    "messages",
    messageRows.map((message) => ({
      id: message.id,
      conversationId: message.channelId,
      userId: message.ownerUserId,
      agentId: message.agentId,
      threadId: message.threadId,
      text: message.text,
      status: message.status,
      awaitingRef:
        message.status === "waiting" &&
        typeof message.details.approvalId === "string"
          ? message.details.approvalId
          : null,
      details: message.details,
      createdAt: message.createdAt.toISOString(),
    })),
    (batch, key) => client.messages.import(batch, key),
    (item) => item.id,
  );

  const voiceRows = await database.select().from(voiceSessions);
  const voice = await importAll(
    "voice sessions",
    voiceRows.map((session) => ({
      id: session.id,
      conversationId: session.channelId,
      userId: session.userId,
      anchorMessageId: session.anchorMessageId,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt.toISOString(),
      durationSeconds: session.durationSeconds,
      transcript: session.transcript.entries,
      summary: session.summary,
      summaryStatus: session.summaryStatus,
    })),
    (batch, key) => client.voice.import(batch, key),
    (item) => item.id,
  );

  const taskRows = await database.select().from(botTasks);
  const tasks = await importAll(
    "tasks",
    taskRows.map((task) => ({
      id: task.id,
      userId: task.ownerUserId,
      agentId: task.agentId,
      conversationId: task.channelId,
      originRef: task.suggestionId,
      origin: task.origin,
      title: task.title,
      why: task.why,
      sourceApp: task.sourceApp,
      sourceLink: task.sourceLink,
      resolvedAt: task.resolvedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    })),
    (batch, key) => client.tasks.import(batch, key),
    (item) => item.id,
  );

  const total =
    conversations.present + messages.present + voice.present + tasks.present;
  await database
    .insert(intelligenceCopies)
    .values({ name: CONVERSATION_COPY_NAME, copied: total })
    .onConflictDoNothing();
  const outcome = {
    kind: "copied" as const,
    conversations: drafts.length,
    messages: messageRows.length,
    voiceSessions: voiceRows.length,
    tasks: taskRows.length,
    created:
      conversations.created + messages.created + voice.created + tasks.created,
  };
  console.info(
    JSON.stringify({
      type: "conversations-copied-to-intelligence",
      ...outcome,
    }),
  );
  return outcome;
}

/** For tests: the wire form the copy sends a conversation in. */
export const conversationDraftToWire = draftToWire;
