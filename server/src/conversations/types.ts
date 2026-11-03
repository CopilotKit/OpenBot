/**
 * A conversation as OpenBot holds it: what used to be a `channels` row with its
 * `channel_memberships`, `channel_agents`, `intelligence_channel_mappings` and `group_bot_threads`,
 * and is now one conversation in Intelligence (its `docs/contracts/conversations.md`).
 *
 * OpenBot's code and screens still call these "channels"; Intelligence calls them conversations,
 * because its own Channels are its Slack and Teams adapters. `client.ts` is the one place that
 * translates between the two.
 */

export type ConversationAgent = { agentId: string; addedAt: Date };

export type ConversationMember = {
  userId: string;
  joinedAt: Date;
  pinnedAt: Date | null;
  lastReadAt: Date | null;
};

/**
 * The Intelligence thread one member's turns run in. `agentId` null is the member's own thread in
 * the conversation (what `intelligence_channel_mappings` held); set, it is that member's thread with
 * one Bot of a group conversation (what `group_bot_threads` held).
 */
export type ConversationThread = {
  threadId: string;
  conversationId: string;
  userId: string;
  agentId: string | null;
  createdAt: Date;
};

export type Conversation = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  deletedAt: Date | null;
  name: string;
  description: string;
  suggestedPrompts: string[];
  allowedGroups: string[];
  /** The tenant package that owns it, or null for one a person made. */
  managedBy: string | null;
  summary: string | null;
  summaryAt: Date | null;
  lastMessage: string | null;
  lastMessageSourceId: string | null;
  lastMessageAt: Date | null;
  /**
   * `lastMessageAt` exactly as Intelligence stores it, to the microsecond. A `Date` keeps
   * milliseconds, and a comparison that must not move a line across a "done" uses this instead.
   */
  lastMessageAtExact: string | null;
  lastMessageAgentId: string | null;
  /** The task whose own conversation this is, or null. */
  taskId: string | null;
  agents: ConversationAgent[];
  members: ConversationMember[];
  threads: ConversationThread[];
};

/** A member's own thread in a conversation, or undefined when they have none. */
export function ownThread(
  conversation: Conversation,
  userId: string,
): ConversationThread | undefined {
  return conversation.threads.find(
    (thread) => thread.userId === userId && thread.agentId === null,
  );
}

export function isMember(conversation: Conversation, userId: string): boolean {
  return conversation.members.some((member) => member.userId === userId);
}

export function agentIdsOf(conversation: Conversation): string[] {
  return conversation.agents.map((agent) => agent.agentId);
}

/** What a new conversation is made of, as OpenBot sends it. */
export type ConversationDraft = {
  id: string;
  name: string;
  description?: string;
  suggestedPrompts?: string[];
  allowedGroups?: string[];
  managedBy?: string | null;
  agents?: { agentId: string; addedAt?: Date }[];
  members?: {
    userId: string;
    threadId?: string;
    joinedAt?: Date;
    pinnedAt?: Date | null;
    lastReadAt?: Date | null;
  }[];
  threads?: {
    userId: string;
    agentId: string;
    threadId: string;
    createdAt?: Date;
  }[];
  /** For copying an existing record only. */
  createdAt?: Date;
  deletedAt?: Date | null;
  summary?: string | null;
  summaryAt?: Date | null;
  lastMessage?: string | null;
  lastMessageSourceId?: string | null;
  lastMessageAt?: Date | null;
  lastMessageAgentId?: string | null;
};

export type ConversationChanges = {
  name?: string;
  description?: string;
  suggestedPrompts?: string[];
  allowedGroups?: string[];
  managedBy?: string | null;
  agentIds?: string[];
};

export type ConversationFilter = {
  includeDeleted?: boolean;
  memberUserId?: string;
  agentId?: string;
  managedBy?: string;
  ids?: string[];
  summaryPending?: boolean;
  order?: "created" | "newest" | "recent";
};

export type ConversationMessageStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

/** A line in a group conversation's shared transcript: what `group_messages` held. */
export type ConversationMessage = {
  id: string;
  conversationId: string;
  userId: string;
  agentId: string | null;
  threadId: string | null;
  text: string;
  status: ConversationMessageStatus;
  awaitingRef: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type VoiceSessionRow = {
  id: string;
  conversationId: string;
  userId: string;
  anchorMessageId: string | null;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  transcript: { id: string; role: "user" | "assistant"; text: string }[];
  summary: string | null;
  summaryStatus: "ready" | "failed";
  version: number;
};

/** Work a Bot does for a person in a conversation of its own: what `bot_tasks` held. */
export type AgentTask = {
  id: string;
  userId: string;
  agentId: string;
  conversationId: string;
  /** What it was started from: a check-in item's id. */
  originRef: string | null;
  origin: string;
  title: string;
  why: string | null;
  sourceApp: string | null;
  sourceLink: string | null;
  resolvedAt: Date | null;
  /** `resolvedAt` to the microsecond, for comparing against the work queue's clock. */
  resolvedAtExact: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type ImportResult = {
  id: string;
  status: "created" | "exists" | "refused";
  error?: { code?: string; message?: string };
};
