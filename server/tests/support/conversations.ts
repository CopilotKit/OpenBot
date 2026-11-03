// server/tests/support/conversations.ts
//
// Conversations, group transcripts, voice sessions, tasks, delivery bindings and push devices for
// the tests, in a real Intelligence.
//
// They live in Intelligence's conversations and delivery bindings capabilities, so a test that needs
// one makes it there, through the same client and directories the server uses, and reads it back the
// way the server does. There is no stand-in: a fake that passed while the real one refused would be
// exactly the test that lies.
//
// WHICH INTELLIGENCE: the one `support/bots.ts` names (`TEST_INTELLIGENCE_*`). Missing, every test
// that touches a conversation fails here and says so, rather than skipping.
import { randomUUID } from "node:crypto";
import {
  type ConversationClient,
  createConversationClient,
} from "../../src/conversations/client";
import {
  type ConversationDirectory,
  createConversationDirectory,
  installConversationDirectory,
} from "../../src/conversations/directory";
import { writeKey } from "../../src/conversations/http";
import type {
  AgentTask,
  Conversation,
  ConversationMessage,
  ConversationMessageStatus,
} from "../../src/conversations/types";
import {
  createDeliveryBindingsClient,
  createDeliveryDirectory,
  type DeliveryDirectory,
  installDeliveryDirectory,
  type StoredBinding,
  type StoredDevice,
} from "../../src/delivery/directory";
import type { BindingTransport } from "../../src/delivery/types";
import { testIntelligence, useTestBots } from "./bots";

let started:
  | Promise<{
      conversations: ConversationDirectory;
      delivery: DeliveryDirectory;
    }>
  | undefined;

/**
 * The process's conversation and delivery directories, against the test Intelligence, installed and
 * started, with the Bot directory beside them. Once per process: every file shares them.
 */
export async function useTestConversations(): Promise<{
  conversations: ConversationDirectory;
  delivery: DeliveryDirectory;
}> {
  // The Bot directory starts these too (support/bots.ts), so a test that only asks for Bots has them.
  await useTestBots();
  return startTestConversationDirectories();
}

export function startTestConversationDirectories(): Promise<{
  conversations: ConversationDirectory;
  delivery: DeliveryDirectory;
}> {
  started ??= (async () => {
    const intelligence = testIntelligence();
    const settings = {
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    };
    const conversations = installConversationDirectory(
      createConversationDirectory({
        client: createConversationClient(settings),
        gatewayWsUrl: intelligence.gatewayWsUrl,
      }),
    );
    await conversations.start();
    const delivery = installDeliveryDirectory(
      createDeliveryDirectory({
        client: createDeliveryBindingsClient(settings),
        gatewayWsUrl: intelligence.gatewayWsUrl,
      }),
    );
    await delivery.start();
    return { conversations, delivery };
  })();
  return started;
}

export async function conversationClient(): Promise<ConversationClient> {
  return (await useTestConversations()).conversations.client;
}

/** A thread id of the shape this deployment mints: a UUID. */
export const newThreadId = () => randomUUID();

export type SeedConversation = {
  id?: string;
  name?: string;
  description?: string;
  agentIds?: string[];
  /** Each member, with their own thread unless `threadId` is null. */
  members?: {
    userId: string;
    threadId?: string | null;
    pinnedAt?: Date | null;
    lastReadAt?: Date | null;
    joinedAt?: Date;
  }[];
  /** A Bot's thread in a group, per member. */
  threads?: {
    userId: string;
    agentId: string;
    threadId?: string;
    createdAt?: Date;
  }[];
  managedBy?: string | null;
  createdAt?: Date | string;
  deletedAt?: Date | null;
  summary?: string | null;
  lastMessage?: string | null;
  lastMessageAt?: Date | null;
  lastMessageAgentId?: string | null;
  lastMessageSourceId?: string | null;
};

/**
 * Make a conversation in Intelligence, as `INSERT INTO channels` with its memberships, Bots and
 * mappings used to. Each member gets a thread of their own unless the test says otherwise.
 */
export async function seedConversation(
  input: SeedConversation = {},
): Promise<Conversation> {
  const { conversations } = await useTestConversations();
  const id = input.id ?? `channel_${randomUUID()}`;
  return conversations.create(
    {
      id,
      name: input.name ?? `Test conversation ${id.slice(-8)}`,
      description: input.description ?? "Private agent channel.",
      managedBy: input.managedBy ?? null,
      agents: (input.agentIds ?? []).map((agentId) => ({ agentId })),
      members: (input.members ?? []).map((member) => ({
        userId: member.userId,
        ...(member.threadId === null
          ? {}
          : { threadId: member.threadId ?? newThreadId() }),
        ...(member.joinedAt ? { joinedAt: member.joinedAt } : {}),
        pinnedAt: member.pinnedAt ?? null,
        lastReadAt: member.lastReadAt ?? null,
      })),
      threads: (input.threads ?? []).map((thread) => ({
        userId: thread.userId,
        agentId: thread.agentId,
        threadId: thread.threadId ?? newThreadId(),
        ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
      })),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.deletedAt ? { deletedAt: input.deletedAt } : {}),
      ...(input.summary
        ? { summary: input.summary, summaryAt: new Date() }
        : {}),
      ...(input.lastMessage
        ? {
            lastMessage: input.lastMessage,
            lastMessageAt: input.lastMessageAt ?? new Date(),
            lastMessageAgentId: input.lastMessageAgentId ?? null,
            lastMessageSourceId: input.lastMessageSourceId ?? null,
          }
        : {}),
    },
    writeKey("test.seed"),
  );
}

/** One person's conversation with these Bots: the shape `POST /api/channels` makes. */
export async function seedChannel(
  userId: string,
  agentIds: string[],
  input: Omit<SeedConversation, "agentIds" | "members"> & {
    threadId?: string;
    pinnedAt?: Date | null;
    lastReadAt?: Date | null;
  } = {},
): Promise<Conversation> {
  const { threadId, pinnedAt, lastReadAt, ...rest } = input;
  return seedConversation({
    ...rest,
    agentIds,
    members: [
      { userId, threadId: threadId ?? newThreadId(), pinnedAt, lastReadAt },
    ],
  });
}

/** The conversation as Intelligence holds it now, past this process's memory. Throws when absent. */
export async function storedConversation(id: string): Promise<Conversation> {
  const conversation = await (await conversationClient()).get(id);
  if (!conversation) throw new Error(`Intelligence has no conversation ${id}`);
  return conversation;
}

/** The conversation, or null when Intelligence has none. */
export async function maybeConversation(
  id: string,
): Promise<Conversation | null> {
  return (await conversationClient()).get(id);
}

/** The thread a member holds in a conversation as their own. Throws when they hold none. */
export async function ownThreadOf(
  conversationId: string,
  userId: string,
): Promise<string> {
  const conversation = await storedConversation(conversationId);
  const thread = conversation.threads.find(
    (candidate) => candidate.userId === userId && candidate.agentId === null,
  );
  if (!thread)
    throw new Error(
      `${userId} has no thread of their own in ${conversationId}`,
    );
  return thread.threadId;
}

/** Remove conversations for good, as test cleanup. One already gone is fine. */
export async function purgeConversations(
  ids: readonly string[],
): Promise<void> {
  const { conversations } = await useTestConversations();
  for (const id of ids) {
    await conversations.client.purge(id, writeKey("test.purge"));
    conversations.invalidate(id);
  }
}

/** Soft-delete a conversation, as deleting it does, at its current version. */
export async function deleteConversation(id: string): Promise<Conversation> {
  const { conversations } = await useTestConversations();
  return conversations.apply(
    await conversations.client.remove(id, writeKey("test.delete")),
  );
}

/** A line in a group's shared transcript, as `INSERT INTO group_messages` made. */
export async function seedMessage(input: {
  id?: string;
  conversationId: string;
  userId: string;
  agentId?: string | null;
  threadId?: string | null;
  text: string;
  status?: ConversationMessageStatus;
  details?: Record<string, unknown>;
  createdAt?: Date;
}): Promise<ConversationMessage> {
  const client = await conversationClient();
  const status = input.status ?? "completed";
  const details = input.details ?? {};
  const { message } = await client.messages.create(
    {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      userId: input.userId,
      agentId: input.agentId ?? null,
      threadId: input.threadId ?? null,
      text: input.text,
      status,
      details,
      awaitingRef:
        status === "waiting" && typeof details.approvalId === "string"
          ? details.approvalId
          : null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
    writeKey("test.message"),
  );
  return message;
}

/** A group's transcript as Intelligence holds it, oldest first (the last two hundred). */
export async function storedMessages(
  conversationId: string,
): Promise<ConversationMessage[]> {
  const client = await conversationClient();
  return (await client.messages.latest(conversationId, 200)).messages.reverse();
}

/** A task, on an existing conversation, as `INSERT INTO bot_tasks` made. */
export async function seedTask(input: {
  id?: string;
  userId: string;
  agentId: string;
  conversationId: string;
  originRef?: string | null;
  title?: string;
  why?: string | null;
  sourceApp?: string | null;
  sourceLink?: string | null;
  createdAt?: Date;
  resolvedAt?: Date | null;
}): Promise<AgentTask> {
  const client = await conversationClient();
  const { task } = await client.tasks.create(
    {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      originRef: input.originRef ?? null,
      origin: "check_in",
      title: input.title ?? "A task",
      why: input.why ?? null,
      sourceApp: input.sourceApp ?? null,
      sourceLink: input.sourceLink ?? null,
      ...(input.createdAt
        ? { createdAt: input.createdAt, updatedAt: input.createdAt }
        : {}),
      ...(input.resolvedAt ? { resolvedAt: input.resolvedAt } : {}),
    },
    writeKey("test.task"),
  );
  return task;
}

export async function storedTask(id: string): Promise<AgentTask | null> {
  return (await conversationClient()).tasks.get(id);
}

/** A person's tasks as Intelligence holds them, newest first. */
export async function storedTasks(userId: string): Promise<AgentTask[]> {
  return (await conversationClient()).tasks.upTo({ userId }, 1000);
}

/** A delivery binding, as `INSERT INTO delivery_bindings` made. */
export async function seedBinding(input: {
  id?: string;
  ownerUserId: string;
  channelId: string;
  agentId: string;
  threadId: string;
  transport?: BindingTransport;
  realm?: string;
  identity?: string;
  address?: string;
  mentionId?: string | null;
  enabled?: boolean;
  createdAt?: Date;
}): Promise<StoredBinding> {
  const { delivery } = await useTestConversations();
  const binding = await delivery.bind({
    id: input.id ?? randomUUID(),
    ownerUserId: input.ownerUserId,
    channelId: input.channelId,
    agentId: input.agentId,
    threadId: input.threadId,
    transport: input.transport ?? "slack",
    realm: input.realm ?? `T${randomUUID().slice(0, 8)}`,
    identity: input.identity ?? `U${randomUUID().slice(0, 8)}`,
    address: input.address ?? `D${randomUUID().slice(0, 8)}`,
    mentionId: input.mentionId ?? null,
  });
  if (input.enabled === false)
    return (
      (await delivery.changeBinding(binding.id, { enabled: false })) ?? binding
    );
  return binding;
}

/** A push device, as `INSERT INTO push_devices` made. */
export async function seedDevice(input: {
  id?: string;
  ownerUserId: string;
  token?: string;
  projectId?: string;
  platform?: "ios" | "android";
}): Promise<StoredDevice> {
  const { delivery } = await useTestConversations();
  return delivery.register({
    id: input.id ?? randomUUID(),
    ownerUserId: input.ownerUserId,
    token: input.token ?? `ExponentPushToken[${randomUUID()}]`,
    projectId: input.projectId ?? "test-project",
    platform: input.platform ?? "ios",
  });
}

/** Every binding this person has, as Intelligence holds them now. */
export async function storedBindings(
  ownerUserId: string,
): Promise<StoredBinding[]> {
  const { delivery } = await useTestConversations();
  await delivery.resync();
  return delivery
    .bindings()
    .filter((binding) => binding.ownerUserId === ownerUserId);
}

/** Every push device this person has, as Intelligence holds them now. */
export async function storedDevices(
  ownerUserId: string,
): Promise<StoredDevice[]> {
  const { delivery } = await useTestConversations();
  await delivery.resync();
  return delivery
    .devices()
    .filter((device) => device.ownerUserId === ownerUserId);
}

/**
 * Add a person to a conversation with a thread of their own, as adding someone to a group does, and
 * keep the answer in this process's directory so the next read sees them at once.
 */
export async function addConversationMember(
  conversationId: string,
  userId: string,
  threadId: string = newThreadId(),
): Promise<Conversation> {
  const { conversations } = await useTestConversations();
  return conversations.apply(
    await conversations.client.addMember(
      conversationId,
      userId,
      { threadId },
      writeKey("test.member"),
    ),
  );
}

/**
 * Wait until `ready` holds, for what arrives from Intelligence's change announcements (they are not
 * the same transaction as the write, so a test reads them as they come). Then wait `quietMs` more,
 * so a test that counts what arrived also sees anything that should NOT have come.
 */
export async function eventually(
  ready: () => boolean,
  options: { timeoutMs?: number; quietMs?: number; what?: string } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (!ready()) {
    if (Date.now() > deadline)
      throw new Error(
        `${options.what ?? "The expected announcements"} did not arrive in time.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (options.quietMs)
    await new Promise((resolve) => setTimeout(resolve, options.quietMs));
}

/**
 * A second server instance's view of conversations: a directory of its own with its own subscription
 * to Intelligence's announcements, sharing nothing with the writer but Intelligence. What it hears is
 * what another replica would. Resolves once it is subscribed; `stop` it when done.
 */
export async function otherReplica(): Promise<ConversationDirectory> {
  const intelligence = testIntelligence();
  const replica = createConversationDirectory({
    client: createConversationClient({
      apiUrl: intelligence.apiUrl,
      apiKey: intelligence.apiKey,
    }),
    gatewayWsUrl: intelligence.gatewayWsUrl,
  });
  await replica.start();
  await eventually(() => replica.subscribed(), {
    what: "The second instance's subscription",
  });
  return replica;
}
