/**
 * Intelligence's conversations capability, as OpenBot calls it: conversations with their members,
 * Bots and thread pointers, a group's shared transcript, voice sessions and tasks, under this
 * deployment's project key. The contract is Intelligence's `docs/contracts/conversations.md`.
 *
 * Nothing here holds a database connection: never call it with an OpenBot transaction open.
 */
import {
  createIntelligenceHttp,
  date,
  encode,
  IntelligenceApiError,
  type IntelligenceApiSettings,
  refused,
} from "./http";
import type {
  AgentTask,
  Conversation,
  ConversationChanges,
  ConversationDraft,
  ConversationFilter,
  ConversationMessage,
  ConversationMessageStatus,
  ConversationThread,
  ImportResult,
  VoiceSessionRow,
} from "./types";

/** No such conversation, a deleted one, or one the named person is not in: one answer for all. */
export class ConversationMissingError extends IntelligenceApiError {
  constructor(id: string) {
    super(`Conversation ${id} was not found.`, 404, "CONVERSATION_NOT_FOUND");
    this.name = "ConversationMissingError";
  }
}

/** The conversation changed since it was read. */
export class ConversationVersionConflictError extends IntelligenceApiError {
  constructor(id: string) {
    super(
      `Conversation ${id} changed since it was read.`,
      412,
      "CONVERSATION_VERSION_CONFLICT",
    );
    this.name = "ConversationVersionConflictError";
  }
}

export class ConversationAlreadyExistsError extends IntelligenceApiError {
  constructor(id: string) {
    super(
      `Conversation ${id} already exists.`,
      409,
      "CONVERSATION_ALREADY_EXISTS",
    );
    this.name = "ConversationAlreadyExistsError";
  }
}

/** An activity report named a Bot that is not in the conversation. */
export class ConversationAgentMissingError extends IntelligenceApiError {
  constructor(id: string) {
    super(
      `That Bot is not in conversation ${id}.`,
      409,
      "CONVERSATION_AGENT_NOT_PRESENT",
    );
    this.name = "ConversationAgentMissingError";
  }
}

type WireConversation = {
  id: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  name: string;
  description: string;
  suggestedPrompts: string[];
  allowedGroups: string[];
  managedBy: string | null;
  summary: string | null;
  summaryAt: string | null;
  lastMessage: string | null;
  lastMessageSourceId: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  taskId: string | null;
  agents: { agentId: string; addedAt: string }[];
  members: {
    userId: string;
    joinedAt: string;
    pinnedAt: string | null;
    lastReadAt: string | null;
  }[];
  threads: {
    threadId: string;
    userId: string;
    agentId: string | null;
    createdAt: string;
  }[];
};

type WireThread = {
  threadId: string;
  conversationId: string;
  userId: string;
  agentId: string | null;
  createdAt: string;
};

type WireMessage = Omit<ConversationMessage, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

type WireTask = Omit<
  AgentTask,
  "createdAt" | "updatedAt" | "resolvedAt" | "resolvedAtExact"
> & { createdAt: string; updatedAt: string; resolvedAt: string | null };

export function conversationFromWire(wire: WireConversation): Conversation {
  return {
    id: wire.id,
    createdAt: new Date(wire.createdAt),
    updatedAt: new Date(wire.updatedAt),
    version: wire.version,
    deletedAt: date(wire.deletedAt),
    name: wire.name,
    description: wire.description,
    suggestedPrompts: wire.suggestedPrompts ?? [],
    allowedGroups: wire.allowedGroups ?? [],
    managedBy: wire.managedBy,
    summary: wire.summary,
    summaryAt: date(wire.summaryAt),
    lastMessage: wire.lastMessage,
    lastMessageSourceId: wire.lastMessageSourceId,
    lastMessageAt: date(wire.lastMessageAt),
    lastMessageAtExact: wire.lastMessageAt,
    lastMessageAgentId: wire.lastMessageAgentId,
    taskId: wire.taskId ?? null,
    agents: wire.agents.map((agent) => ({
      agentId: agent.agentId,
      addedAt: new Date(agent.addedAt),
    })),
    members: wire.members.map((member) => ({
      userId: member.userId,
      joinedAt: new Date(member.joinedAt),
      pinnedAt: date(member.pinnedAt),
      lastReadAt: date(member.lastReadAt),
    })),
    threads: wire.threads.map((thread) => ({
      threadId: thread.threadId,
      conversationId: wire.id,
      userId: thread.userId,
      agentId: thread.agentId,
      createdAt: new Date(thread.createdAt),
    })),
  };
}

function threadFromWire(wire: WireThread): ConversationThread {
  return { ...wire, createdAt: new Date(wire.createdAt) };
}

function messageFromWire(wire: WireMessage): ConversationMessage {
  return {
    ...wire,
    details: wire.details ?? {},
    createdAt: new Date(wire.createdAt),
    updatedAt: new Date(wire.updatedAt),
  };
}

function taskFromWire(wire: WireTask): AgentTask {
  return {
    ...wire,
    resolvedAt: date(wire.resolvedAt),
    resolvedAtExact: wire.resolvedAt,
    createdAt: new Date(wire.createdAt),
    updatedAt: new Date(wire.updatedAt),
  };
}

/** A timestamp as sent: a `Date` to the millisecond, or a string as given (to the microsecond). */
const iso = (value: Date | string | null | undefined) =>
  value === undefined
    ? undefined
    : value === null
      ? null
      : typeof value === "string"
        ? value
        : value.toISOString();

/** Drop the keys whose value is undefined, so a strict body never sees them. */
function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

export function draftToWire(draft: ConversationDraft) {
  return defined({
    id: draft.id,
    name: draft.name,
    description: draft.description,
    suggestedPrompts: draft.suggestedPrompts,
    allowedGroups: draft.allowedGroups,
    managedBy: draft.managedBy,
    agents: draft.agents?.map((agent) =>
      defined({ agentId: agent.agentId, addedAt: iso(agent.addedAt) }),
    ),
    members: draft.members?.map((member) =>
      defined({
        userId: member.userId,
        threadId: member.threadId,
        joinedAt: iso(member.joinedAt),
        pinnedAt: iso(member.pinnedAt),
        lastReadAt: iso(member.lastReadAt),
      }),
    ),
    threads: draft.threads?.map((thread) =>
      defined({
        userId: thread.userId,
        agentId: thread.agentId,
        threadId: thread.threadId,
        createdAt: iso(thread.createdAt),
      }),
    ),
    createdAt: iso(draft.createdAt),
    deletedAt: iso(draft.deletedAt),
    summary: draft.summary,
    summaryAt: iso(draft.summaryAt),
    lastMessage: draft.lastMessage,
    lastMessageSourceId: draft.lastMessageSourceId,
    lastMessageAt: iso(draft.lastMessageAt),
    lastMessageAgentId: draft.lastMessageAgentId,
  });
}

export type ConversationPage = {
  conversations: Conversation[];
  nextCursor: string | null;
  joinCode: string | null;
};

export type ConversationClient = ReturnType<typeof createConversationClient>;

export type TaskFilter = {
  userId?: string;
  agentId?: string;
  conversationId?: string;
  originRef?: string;
  ids?: string[];
  listedSince?: Date;
  open?: boolean;
};

export function createConversationClient(settings: IntelligenceApiSettings) {
  const request = createIntelligenceHttp(settings);
  const path = (id: string) => `/api/conversations/${encode(id)}`;

  async function one(response: Response): Promise<Conversation> {
    return conversationFromWire((await response.json()) as WireConversation);
  }

  async function refusal(
    response: Response,
    id: string,
    action: string,
  ): Promise<never> {
    if (response.status === 404) throw new ConversationMissingError(id);
    if (response.status === 412) throw new ConversationVersionConflictError(id);
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: { code?: string } } | null;
    const code = body?.error?.code ?? null;
    if (code === "CONVERSATION_ALREADY_EXISTS")
      throw new ConversationAlreadyExistsError(id);
    if (code === "CONVERSATION_AGENT_NOT_PRESENT")
      throw new ConversationAgentMissingError(id);
    return refused(response, `${action} conversation ${id}`);
  }

  async function pageConversations(
    filter: ConversationFilter = {},
    cursor: string | null = null,
    limit = 100,
  ): Promise<ConversationPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    if (filter.includeDeleted) query.set("includeDeleted", "true");
    if (filter.memberUserId) query.set("memberUserId", filter.memberUserId);
    if (filter.agentId) query.set("agentId", filter.agentId);
    if (filter.managedBy) query.set("managedBy", filter.managedBy);
    if (filter.ids) query.set("ids", filter.ids.join(","));
    if (filter.summaryPending) query.set("summaryPending", "true");
    if (filter.order) query.set("order", filter.order);
    const response = await request("GET", `/api/conversations?${query}`);
    if (response.status !== 200) return refused(response, "list conversations");
    const body = (await response.json()) as {
      conversations: WireConversation[];
      nextCursor: string | null;
      joinCode?: string | null;
    };
    return {
      conversations: body.conversations.map(conversationFromWire),
      nextCursor: body.nextCursor,
      joinCode: body.joinCode ?? null,
    };
  }

  async function pageTasks(
    filter: {
      userId?: string;
      agentId?: string;
      conversationId?: string;
      originRef?: string;
      ids?: string[];
      listedSince?: Date;
      open?: boolean;
    },
    cursor: string | null = null,
    limit = 100,
  ): Promise<{ tasks: AgentTask[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    if (filter.userId) query.set("userId", filter.userId);
    if (filter.agentId) query.set("agentId", filter.agentId);
    if (filter.conversationId)
      query.set("conversationId", filter.conversationId);
    if (filter.originRef) query.set("originRef", filter.originRef);
    if (filter.ids) query.set("ids", filter.ids.join(","));
    if (filter.listedSince)
      query.set("listedSince", filter.listedSince.toISOString());
    if (filter.open) query.set("open", "true");
    const response = await request("GET", `/api/agent-tasks?${query}`);
    if (response.status !== 200) return refused(response, "list tasks");
    const body = (await response.json()) as {
      tasks: WireTask[];
      nextCursor: string | null;
    };
    return {
      tasks: body.tasks.map(taskFromWire),
      nextCursor: body.nextCursor,
    };
  }

  const client = {
    async create(draft: ConversationDraft, key: string): Promise<Conversation> {
      const response = await request("POST", "/api/conversations", {
        body: draftToWire(draft),
        idempotencyKey: key,
      });
      if (response.status !== 201 && response.status !== 200)
        return refusal(response, draft.id, "create");
      return one(response);
    },

    async import(
      drafts: ConversationDraft[],
      key: string,
    ): Promise<ImportResult[]> {
      const response = await request("POST", "/api/conversations/import", {
        body: { conversations: drafts.map(draftToWire) },
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refused(response, "import conversations");
      return ((await response.json()) as { results: ImportResult[] }).results;
    },

    /** The person's one conversation with this Bot alone, made from `create` when there is none. */
    async direct(
      input: {
        userId: string;
        agentId: string;
        create: {
          id: string;
          name: string;
          description: string;
          threadId: string;
        };
      },
      key: string,
    ): Promise<{ conversation: Conversation; created: boolean }> {
      const response = await request("POST", "/api/conversations/direct", {
        body: input,
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refusal(response, input.create.id, "find or make");
      const body = (await response.json()) as {
        conversation: WireConversation;
        created: boolean;
      };
      return {
        conversation: conversationFromWire(body.conversation),
        created: body.created,
      };
    },

    /** The conversation, deleted ones included, or null when Intelligence has none. */
    async get(id: string): Promise<Conversation | null> {
      const response = await request("GET", `${path(id)}?includeDeleted=true`);
      if (response.status === 404) return null;
      if (response.status !== 200) return refusal(response, id, "read");
      return one(response);
    },

    page: pageConversations,

    /** Every conversation matching the filter, walking every page. No cap: the cursor decides. */
    async all(filter: ConversationFilter = {}): Promise<Conversation[]> {
      const found: Conversation[] = [];
      let cursor: string | null = null;
      do {
        const page: ConversationPage = await pageConversations(
          filter,
          cursor,
          200,
        );
        found.push(...page.conversations);
        cursor = page.nextCursor;
      } while (cursor);
      return found;
    },

    /** These conversations, deleted ones included, in batches of a hundred. */
    async many(ids: readonly string[]): Promise<Conversation[]> {
      const unique = [...new Set(ids)];
      const found: Conversation[] = [];
      for (let at = 0; at < unique.length; at += 100) {
        const page = await pageConversations(
          { ids: unique.slice(at, at + 100), includeDeleted: true },
          null,
          100,
        );
        found.push(...page.conversations);
      }
      return found;
    },

    async update(
      id: string,
      version: number,
      changes: ConversationChanges,
      key: string,
    ): Promise<Conversation> {
      const response = await request("PATCH", path(id), {
        body: changes,
        ifMatch: version,
        idempotencyKey: key,
      });
      if (response.status !== 200) return refusal(response, id, "change");
      return one(response);
    },

    /** Soft delete; one already deleted comes back unchanged. */
    async remove(
      id: string,
      key: string,
      version?: number,
    ): Promise<Conversation> {
      const response = await request("DELETE", path(id), {
        idempotencyKey: key,
        ...(version === undefined ? {} : { ifMatch: version }),
      });
      if (response.status !== 200) return refusal(response, id, "delete");
      return one(response);
    },

    async restore(id: string, key: string): Promise<Conversation> {
      const response = await request("POST", `${path(id)}/restore`, {
        idempotencyKey: key,
      });
      if (response.status !== 200) return refusal(response, id, "restore");
      return one(response);
    },

    /** Delete for good. False when it was already gone. */
    async purge(id: string, key: string): Promise<boolean> {
      const response = await request("DELETE", `${path(id)}?purge=true`, {
        idempotencyKey: key,
      });
      if (response.status === 404) return false;
      if (response.status !== 204) return refusal(response, id, "purge");
      return true;
    },

    async activity(
      id: string,
      body: {
        userId: string;
        text: string;
        at: Date;
        agentId: string | null;
        sourceId: string | null;
        enrichFrom: string | null;
      },
      key: string,
    ): Promise<{ applied: boolean; conversation: Conversation }> {
      const response = await request("POST", `${path(id)}/activity`, {
        body: { ...body, at: body.at.toISOString() },
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refusal(response, id, "record activity in");
      const result = (await response.json()) as {
        applied: boolean;
        conversation: WireConversation;
      };
      return {
        applied: result.applied,
        conversation: conversationFromWire(result.conversation),
      };
    },

    async summary(
      id: string,
      summary: string,
      key: string,
      onlyIfAbsent = true,
    ): Promise<{ applied: boolean; conversation: Conversation }> {
      const response = await request("POST", `${path(id)}/summary`, {
        body: { summary, onlyIfAbsent },
        idempotencyKey: key,
      });
      if (response.status !== 200) return refusal(response, id, "summarise");
      const result = (await response.json()) as {
        applied: boolean;
        conversation: WireConversation;
      };
      return {
        applied: result.applied,
        conversation: conversationFromWire(result.conversation),
      };
    },

    async addMember(
      id: string,
      userId: string,
      body: { threadId?: string },
      key: string,
    ): Promise<Conversation> {
      const response = await request(
        "PUT",
        `${path(id)}/members/${encode(userId)}`,
        { body, idempotencyKey: key },
      );
      if (response.status !== 200 && response.status !== 201)
        return refusal(response, id, "add a member to");
      return one(response);
    },

    async changeMember(
      id: string,
      userId: string,
      body: { pinned?: boolean; read?: true },
      key: string,
    ): Promise<Conversation> {
      const response = await request(
        "PATCH",
        `${path(id)}/members/${encode(userId)}`,
        { body, idempotencyKey: key },
      );
      if (response.status !== 200)
        return refusal(response, id, "change a member of");
      return one(response);
    },

    async removeMember(
      id: string,
      userId: string,
      key: string,
    ): Promise<Conversation> {
      const response = await request(
        "DELETE",
        `${path(id)}/members/${encode(userId)}`,
        { idempotencyKey: key },
      );
      if (response.status !== 200)
        return refusal(response, id, "remove a member from");
      return one(response);
    },

    /** The thread this member holds with this Bot, written from `threadId` when they hold none. */
    async thread(
      id: string,
      body: {
        userId: string;
        agentId: string | null;
        threadId: string;
        createdAt?: Date;
      },
      key: string,
    ): Promise<{ thread: ConversationThread; created: boolean }> {
      const response = await request("POST", `${path(id)}/threads`, {
        body: defined({ ...body, createdAt: iso(body.createdAt) }),
        idempotencyKey: key,
      });
      if (response.status !== 200 && response.status !== 201)
        return refusal(response, id, "write a thread for");
      return {
        thread: threadFromWire((await response.json()) as WireThread),
        created: response.status === 201,
      };
    },

    /** Forget a Bot gone for good, everywhere conversations and tasks name it. */
    async purgeAgent(agentId: string, key: string): Promise<void> {
      const response = await request("POST", "/api/conversations/purge-agent", {
        body: { agentId },
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refused(response, `forget Bot ${agentId} in conversations`);
    },

    /** Every Bot id a conversation, thread, message or task names. */
    async agentReferences(): Promise<string[]> {
      const response = await request("GET", "/api/conversation-agents");
      if (response.status !== 200)
        return refused(response, "list the Bots conversations name");
      return ((await response.json()) as { agentIds: string[] }).agentIds;
    },

    /** Credentials for the realtime topic that announces every change to this project's conversations. */
    async subscribe(): Promise<{ joinToken: string; joinCode: string }> {
      const response = await request("POST", "/api/conversations/subscribe", {
        body: {},
      });
      if (response.status !== 200)
        return refused(response, "subscribe to conversations");
      return (await response.json()) as { joinToken: string; joinCode: string };
    },

    /** The pointer naming this thread, with its conversation, or null. */
    async byThread(threadId: string): Promise<{
      thread: ConversationThread;
      conversation: Conversation;
    } | null> {
      const response = await request(
        "GET",
        `/api/conversation-threads/${encode(threadId)}`,
      );
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refused(response, `look up thread ${threadId}`);
      const body = (await response.json()) as {
        thread: WireThread;
        conversation: WireConversation;
      };
      return {
        thread: threadFromWire(body.thread),
        conversation: conversationFromWire(body.conversation),
      };
    },

    /** The pointers that exist for these threads, in batches of a hundred. */
    async lookupThreads(
      threadIds: readonly string[],
    ): Promise<ConversationThread[]> {
      const unique = [...new Set(threadIds.filter(Boolean))];
      const found: ConversationThread[] = [];
      for (let at = 0; at < unique.length; at += 100) {
        const response = await request(
          "POST",
          "/api/conversation-threads/lookup",
          { body: { threadIds: unique.slice(at, at + 100) } },
        );
        if (response.status !== 200)
          return refused(response, "look up threads");
        found.push(
          ...((await response.json()) as { threads: WireThread[] }).threads.map(
            threadFromWire,
          ),
        );
      }
      return found;
    },

    /** Per Bot, how many of this person's live conversations it spoke in since they last looked. */
    async unread(
      userId: string,
    ): Promise<{ agentId: string; conversations: number }[]> {
      const response = await request(
        "GET",
        `/api/conversation-members/${encode(userId)}/unread`,
      );
      if (response.status !== 200)
        return refused(response, "count unread conversations");
      return (
        (await response.json()) as {
          agents: { agentId: string; conversations: number }[];
        }
      ).agents;
    },

    messages: {
      /** Create-if-absent: `created` false hands back the stored message whatever was sent. */
      async create(
        message: {
          id: string;
          conversationId: string;
          userId: string;
          agentId?: string | null;
          threadId?: string | null;
          text: string;
          status: ConversationMessageStatus;
          awaitingRef?: string | null;
          details?: Record<string, unknown>;
          createdAt?: Date;
        },
        key: string,
      ): Promise<{ message: ConversationMessage; created: boolean }> {
        const response = await request("POST", "/api/conversation-messages", {
          body: defined({ ...message, createdAt: iso(message.createdAt) }),
          idempotencyKey: key,
        });
        if (response.status === 404)
          throw new ConversationMissingError(message.conversationId);
        if (response.status !== 200 && response.status !== 201)
          return refused(response, `write message ${message.id}`);
        return {
          message: messageFromWire((await response.json()) as WireMessage),
          created: response.status === 201,
        };
      },

      async import(
        items: Record<string, unknown>[],
        key: string,
      ): Promise<ImportResult[]> {
        const response = await request(
          "POST",
          "/api/conversation-messages/import",
          { body: { messages: items }, idempotencyKey: key },
        );
        if (response.status !== 200)
          return refused(response, "import messages");
        return ((await response.json()) as { results: ImportResult[] }).results;
      },

      /** The newest `limit` lines of a conversation, newest first. */
      async latest(
        conversationId: string,
        limit = 200,
        cursor: string | null = null,
      ): Promise<{
        messages: ConversationMessage[];
        nextCursor: string | null;
      }> {
        const query = new URLSearchParams({
          conversationId,
          limit: String(limit),
        });
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          "GET",
          `/api/conversation-messages?${query}`,
        );
        if (response.status !== 200)
          return refused(response, `read the messages of ${conversationId}`);
        const body = (await response.json()) as {
          messages: WireMessage[];
          nextCursor: string | null;
        };
        return {
          messages: body.messages.map(messageFromWire),
          nextCursor: body.nextCursor,
        };
      },

      async awaiting(
        awaitingRef: string,
        status: ConversationMessageStatus = "waiting",
      ): Promise<ConversationMessage[]> {
        const query = new URLSearchParams({ status, awaitingRef, limit: "10" });
        const response = await request(
          "GET",
          `/api/conversation-messages?${query}`,
        );
        if (response.status !== 200)
          return refused(response, "find a waiting message");
        return (
          (await response.json()) as { messages: WireMessage[] }
        ).messages.map(messageFromWire);
      },

      async get(id: string): Promise<ConversationMessage | null> {
        const response = await request(
          "GET",
          `/api/conversation-messages/${encode(id)}`,
        );
        if (response.status === 404) return null;
        if (response.status !== 200)
          return refused(response, `read message ${id}`);
        return messageFromWire((await response.json()) as WireMessage);
      },

      async change(
        id: string,
        body: {
          text?: string;
          status?: ConversationMessageStatus;
          awaitingRef?: string | null;
          details?: Record<string, unknown>;
          expectStatus?: ConversationMessageStatus;
        },
        key: string,
      ): Promise<{ applied: boolean; message: ConversationMessage | null }> {
        const response = await request(
          "PATCH",
          `/api/conversation-messages/${encode(id)}`,
          { body, idempotencyKey: key },
        );
        if (response.status === 404) return { applied: false, message: null };
        if (response.status !== 200)
          return refused(response, `change message ${id}`);
        const result = (await response.json()) as {
          applied: boolean;
          message: WireMessage;
        };
        return {
          applied: result.applied,
          message: messageFromWire(result.message),
        };
      },
    },

    voice: {
      async create(
        session: Omit<
          VoiceSessionRow,
          "version" | "summary" | "summaryStatus"
        > & {
          summary?: string | null;
          summaryStatus?: "ready" | "failed";
        },
        key: string,
      ): Promise<{ session: VoiceSessionRow; created: boolean }> {
        const response = await request("POST", "/api/voice-sessions", {
          body: defined(session),
          idempotencyKey: key,
        });
        if (response.status === 404)
          throw new ConversationMissingError(session.conversationId);
        if (response.status !== 200 && response.status !== 201)
          return refused(response, `save voice session ${session.id}`);
        return {
          session: (await response.json()) as VoiceSessionRow,
          created: response.status === 201,
        };
      },

      async import(
        items: Record<string, unknown>[],
        key: string,
      ): Promise<ImportResult[]> {
        const response = await request("POST", "/api/voice-sessions/import", {
          body: { sessions: items },
          idempotencyKey: key,
        });
        if (response.status !== 200)
          return refused(response, "import voice sessions");
        return ((await response.json()) as { results: ImportResult[] }).results;
      },

      async page(
        conversationId: string,
        cursor: string | null,
        limit = 50,
      ): Promise<{ sessions: VoiceSessionRow[]; nextCursor: string | null }> {
        const query = new URLSearchParams({
          conversationId,
          limit: String(limit),
        });
        if (cursor) query.set("cursor", cursor);
        const response = await request("GET", `/api/voice-sessions?${query}`);
        if (response.status === 400)
          throw new IntelligenceApiError(
            "Invalid voice history cursor.",
            400,
            "CONVERSATION_VALIDATION_ERROR",
          );
        if (response.status !== 200)
          return refused(response, "list voice sessions");
        return (await response.json()) as {
          sessions: VoiceSessionRow[];
          nextCursor: string | null;
        };
      },

      async get(id: string): Promise<VoiceSessionRow | null> {
        const response = await request(
          "GET",
          `/api/voice-sessions/${encode(id)}`,
        );
        if (response.status === 404) return null;
        if (response.status !== 200)
          return refused(response, `read voice session ${id}`);
        return (await response.json()) as VoiceSessionRow;
      },

      async summarise(
        id: string,
        summary: string,
        key: string,
      ): Promise<VoiceSessionRow> {
        const response = await request(
          "PATCH",
          `/api/voice-sessions/${encode(id)}`,
          { body: { summary }, idempotencyKey: key },
        );
        if (response.status !== 200)
          return refused(response, `summarise voice session ${id}`);
        return (await response.json()) as VoiceSessionRow;
      },
    },

    tasks: {
      /**
       * A task, on an existing conversation or with its own new one in the same write. When the
       * origin already opened a task, that task comes back with `created` false and nothing is made.
       */
      async create(
        task: {
          id: string;
          userId: string;
          agentId: string;
          conversationId?: string;
          conversation?: ConversationDraft;
          originRef: string | null;
          origin: string;
          title: string;
          why: string | null;
          sourceApp: string | null;
          sourceLink: string | null;
          createdAt?: Date;
          updatedAt?: Date;
          resolvedAt?: Date | null;
        },
        key: string,
      ): Promise<{ task: AgentTask; created: boolean }> {
        const { conversation, createdAt, updatedAt, resolvedAt, ...rest } =
          task;
        const response = await request("POST", "/api/agent-tasks", {
          body: defined({
            ...rest,
            ...(conversation
              ? { conversation: draftToWire(conversation) }
              : {}),
            createdAt: iso(createdAt),
            updatedAt: iso(updatedAt),
            resolvedAt: iso(resolvedAt),
          }),
          idempotencyKey: key,
        });
        if (response.status !== 200 && response.status !== 201)
          return refused(response, `create task ${task.id}`);
        return {
          task: taskFromWire((await response.json()) as WireTask),
          created: response.status === 201,
        };
      },

      async import(
        items: Record<string, unknown>[],
        key: string,
      ): Promise<ImportResult[]> {
        const response = await request("POST", "/api/agent-tasks/import", {
          body: { tasks: items },
          idempotencyKey: key,
        });
        if (response.status !== 200) return refused(response, "import tasks");
        return ((await response.json()) as { results: ImportResult[] }).results;
      },

      page: pageTasks,

      /** Every task matching the filter, newest first, up to `max`. */
      async upTo(filter: TaskFilter, max: number): Promise<AgentTask[]> {
        const found: AgentTask[] = [];
        let cursor: string | null = null;
        do {
          const page: { tasks: AgentTask[]; nextCursor: string | null } =
            await pageTasks(filter, cursor, Math.min(100, max));
          found.push(...page.tasks);
          cursor = page.nextCursor;
        } while (cursor && found.length < max);
        return found.slice(0, max);
      },

      /** These tasks, in batches of a hundred. */
      async many(ids: readonly string[]): Promise<AgentTask[]> {
        const unique = [...new Set(ids)];
        const found: AgentTask[] = [];
        for (let at = 0; at < unique.length; at += 100)
          found.push(
            ...(await pageTasks({ ids: unique.slice(at, at + 100) })).tasks,
          );
        return found;
      },

      async get(id: string): Promise<AgentTask | null> {
        const response = await request("GET", `/api/agent-tasks/${encode(id)}`);
        if (response.status === 404) return null;
        if (response.status !== 200)
          return refused(response, `read task ${id}`);
        return taskFromWire((await response.json()) as WireTask);
      },

      async resolve(
        id: string,
        resolvedAt: string | null,
        key: string,
      ): Promise<AgentTask | null> {
        const response = await request(
          "PATCH",
          `/api/agent-tasks/${encode(id)}`,
          { body: { resolvedAt }, idempotencyKey: key },
        );
        if (response.status === 404) return null;
        if (response.status !== 200)
          return refused(response, `mark task ${id}`);
        return taskFromWire((await response.json()) as WireTask);
      },
    },
  };
  return client;
}
