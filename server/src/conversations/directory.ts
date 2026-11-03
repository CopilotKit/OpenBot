/**
 * The conversations this server instance has read lately, held in memory and kept fresh from
 * Intelligence.
 *
 * WHY A CACHE, AND WHY NOT ALL OF THEM. A conversation is read on every turn: which conversation a
 * thread belongs to, who is in it, which Bots. Conversations live in Intelligence now, and reading it
 * on each of those would put a network round trip under every turn and tool call. Unlike Bots there
 * is no small whole set to hold: a person who talks to their Bot daily makes thousands. So this holds
 * the ones read recently, up to a bound, and reads through on a miss.
 *
 * HOW IT STAYS FRESH, ACROSS REPLICAS. A write made here updates the cache from Intelligence's answer
 * at once, so this instance reads its own writes. Every other instance hears of it from Intelligence's
 * realtime gateway, which announces each change by id and version; a held conversation is read again
 * when its announcement is newer than the copy. Announcements can be lost, so every held conversation
 * is read again whenever the subscription joins (every reconnect) and on a timer. Versions order what
 * arrives: an older copy never replaces a newer one.
 *
 * THE READ MARKER IS NOT HELD. Intelligence does not version a member's `lastReadAt` (opening a
 * conversation would otherwise wake every subscriber), so a copy here may hold an older one. Nothing
 * that reads from this cache reads it; the roster and the unread counts read Intelligence.
 */
import { type ConversationClient, ConversationMissingError } from "./client";
import { writeKey } from "./http";
import {
  type ProjectChangeSubscription,
  subscribeToProjectChanges,
} from "./project-events";
import type {
  Conversation,
  ConversationChanges,
  ConversationDraft,
  ConversationThread,
} from "./types";

export type ConversationChangeKind =
  | "created"
  | "updated"
  | "activity"
  | "summary"
  | "member"
  | "deleted"
  | "restored"
  | "purged";

export type ConversationChange = {
  conversationId: string;
  version: number;
  change: ConversationChangeKind;
  /** The member a `member` change was about. */
  userId: string | null;
};

const CHANGE_KINDS = new Set<string>([
  "created",
  "updated",
  "activity",
  "summary",
  "member",
  "deleted",
  "restored",
  "purged",
]);

export function parseConversationChange(
  payload: unknown,
): ConversationChange | null {
  if (!payload || typeof payload !== "object") return null;
  const { conversationId, version, change, userId } = payload as Record<
    string,
    unknown
  >;
  if (typeof conversationId !== "string" || typeof version !== "number")
    return null;
  if (typeof change !== "string" || !CHANGE_KINDS.has(change)) return null;
  return {
    conversationId,
    version,
    change: change as ConversationChangeKind,
    userId: typeof userId === "string" ? userId : null,
  };
}

export type ConversationDirectory = {
  /** Subscribe to changes. Resolves once the subscription has been asked for; nothing is preloaded. */
  start(): Promise<void>;
  stop(): void;
  subscribed(): boolean;
  /** From memory only, for code that must not wait. */
  peek(id: string): Conversation | undefined;
  /** From memory, reading through on a miss. Deleted conversations included; null when there is none. */
  get(id: string): Promise<Conversation | null>;
  getMany(ids: Iterable<string>): Promise<Map<string, Conversation>>;
  /** Read from Intelligence now, whatever is held. */
  refresh(id: string): Promise<Conversation | null>;
  /**
   * The pointer naming this thread, with its conversation (deleted ones included), or null when no
   * conversation names the thread.
   */
  byThread(
    threadId: string,
  ): Promise<{ thread: ConversationThread; conversation: Conversation } | null>;
  /** Keep this copy, unless a newer one is held. */
  apply(conversation: Conversation): Conversation;
  /** Drop a held copy, so the next read goes to Intelligence. */
  invalidate(id: string): void;
  create(draft: ConversationDraft, key?: string): Promise<Conversation>;
  update(
    id: string,
    version: number,
    changes: ConversationChanges,
    key?: string,
  ): Promise<Conversation>;
  /** Read every held conversation again. */
  resync(): Promise<void>;
  /** Called after each announced change has been taken in, with the change. */
  onChange(listener: (change: ConversationChange) => void): () => void;
  /** Called when announcements may have been missed: the subscription joined again. */
  onResync(listener: () => void): () => void;
  client: ConversationClient;
};

/** How many conversations one instance holds before the least recently read are dropped. */
const MAX_HELD = 10_000;
/** How many thread pointers one instance remembers the conversation of. */
const MAX_THREADS = 50_000;
const RESYNC_INTERVAL_MS = 15 * 60 * 1_000;
const MISS_TTL_MS = 2_000;

export function createConversationDirectory(options: {
  client: ConversationClient;
  gatewayWsUrl?: string;
  resyncIntervalMs?: number;
  maxHeld?: number;
}): ConversationDirectory {
  const { client } = options;
  const maxHeld = options.maxHeld ?? MAX_HELD;
  const held = new Map<string, Conversation>();
  /** threadId → conversation id. A pointer never changes once written; a removed one is checked. */
  const threads = new Map<string, string>();
  const misses = new Map<string, number>();
  const inFlight = new Map<string, Promise<Conversation | null>>();
  const purgedAt = new Map<string, number>();
  const changeListeners = new Set<(change: ConversationChange) => void>();
  const resyncListeners = new Set<() => void>();
  let subscription: ProjectChangeSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resyncing: Promise<void> | undefined;
  let everJoined = false;

  const touch = (conversation: Conversation) => {
    held.delete(conversation.id);
    held.set(conversation.id, conversation);
    if (held.size > maxHeld) {
      const oldest = held.keys().next().value;
      if (oldest !== undefined) held.delete(oldest);
    }
    for (const thread of conversation.threads) {
      threads.delete(thread.threadId);
      threads.set(thread.threadId, conversation.id);
    }
    while (threads.size > MAX_THREADS) {
      const oldest = threads.keys().next().value;
      if (oldest === undefined) break;
      threads.delete(oldest);
    }
  };

  const apply = (conversation: Conversation, confirmedAt = Date.now()) => {
    const purged = purgedAt.get(conversation.id);
    if (purged !== undefined && purged > confirmedAt) return conversation;
    purgedAt.delete(conversation.id);
    misses.delete(conversation.id);
    const current = held.get(conversation.id);
    if (current && current.version > conversation.version) {
      touch(current);
      return current;
    }
    touch(conversation);
    return conversation;
  };

  const forget = (id: string) => {
    const current = held.get(id);
    held.delete(id);
    purgedAt.set(id, Date.now());
    if (purgedAt.size > 5_000)
      for (const [key, at] of purgedAt)
        if (at < Date.now() - 60_000) purgedAt.delete(key);
    for (const thread of current?.threads ?? [])
      threads.delete(thread.threadId);
  };

  const rememberMiss = (key: string) => {
    const now = Date.now();
    if (misses.size > 5_000)
      for (const [entry, until] of misses)
        if (until <= now) misses.delete(entry);
    misses.set(key, now + MISS_TTL_MS);
  };

  const readThrough = (id: string): Promise<Conversation | null> => {
    const pending = inFlight.get(id);
    if (pending) return pending;
    const startedAt = Date.now();
    const read = client
      .get(id)
      .then((conversation) => {
        if (conversation) return apply(conversation, startedAt);
        if (held.has(id)) forget(id);
        rememberMiss(id);
        return null;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, read);
    return read;
  };

  const heard = async (change: ConversationChange) => {
    try {
      if (change.change === "purged") {
        forget(change.conversationId);
      } else {
        const current = held.get(change.conversationId);
        if (current && current.version < change.version)
          await readThrough(change.conversationId);
        // Not held: nothing here to bring up to date. The next read goes to Intelligence anyway.
        misses.delete(change.conversationId);
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "conversation-change-read-failed",
          conversationId: change.conversationId,
          note: "The next full read picks the change up.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    for (const listener of changeListeners) {
      try {
        listener(change);
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: "conversation-change-listener-failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };

  const readHeld = async () => {
    const ids = [...held.keys()];
    const startedAt = Date.now();
    let joinCode: string | null = null;
    if (ids.length === 0) {
      joinCode = (await client.page({}, null, 1)).joinCode;
    }
    for (let at = 0; at < ids.length; at += 100) {
      const batch = ids.slice(at, at + 100);
      const page = await client.page(
        { ids: batch, includeDeleted: true },
        null,
        100,
      );
      joinCode = page.joinCode ?? joinCode;
      const found = new Set<string>();
      for (const conversation of page.conversations) {
        found.add(conversation.id);
        apply(conversation, startedAt);
      }
      for (const id of batch) if (!found.has(id)) forget(id);
    }
    const subscribed = subscription?.joinCode();
    if (subscribed && subscribed !== joinCode) subscription?.renew();
  };

  const resync = (): Promise<void> => {
    if (resyncing) return resyncing;
    resyncing = readHeld().finally(() => {
      resyncing = undefined;
    });
    return resyncing;
  };

  const directory: ConversationDirectory = {
    client,

    async start() {
      if (options.gatewayWsUrl) {
        subscription = subscribeToProjectChanges({
          name: "conversations",
          topic: "conversations",
          event: "conversation_changed",
          subscribe: () => client.subscribe(),
          gatewayWsUrl: options.gatewayWsUrl,
          parse: parseConversationChange,
          onChange: (change) => {
            void heard(change);
          },
          onJoined: () => {
            const again = everJoined;
            everJoined = true;
            resync().catch((error: unknown) =>
              console.warn(
                JSON.stringify({
                  type: "conversation-resync-failed",
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
            // The first join has nothing before it that could have been missed.
            if (again) for (const listener of resyncListeners) listener();
          },
        });
      }
      timer = setInterval(() => {
        resync().catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              type: "conversation-resync-failed",
              note: "Still serving the conversations this instance last read.",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }, options.resyncIntervalMs ?? RESYNC_INTERVAL_MS);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
      subscription?.stop();
    },

    subscribed: () => subscription?.joinCode() != null,

    peek: (id) => held.get(id),

    async get(id) {
      const current = held.get(id);
      if (current) {
        touch(current);
        return current;
      }
      const missedUntil = misses.get(id);
      if (missedUntil !== undefined && missedUntil > Date.now()) return null;
      return readThrough(id);
    },

    async getMany(ids) {
      const wanted = [...new Set(ids)];
      const found = new Map<string, Conversation>();
      const absent: string[] = [];
      for (const id of wanted) {
        const current = held.get(id);
        if (current) found.set(id, current);
        else absent.push(id);
      }
      if (absent.length > 0) {
        const startedAt = Date.now();
        for (const conversation of await client.many(absent))
          found.set(conversation.id, apply(conversation, startedAt));
      }
      return found;
    },

    refresh: (id) => readThrough(id),

    async byThread(threadId) {
      const known = threads.get(threadId);
      if (known) {
        const conversation = await directory.get(known);
        const thread = conversation?.threads.find(
          (candidate) => candidate.threadId === threadId,
        );
        if (conversation && thread) return { thread, conversation };
        // The pointer is gone from the copy: removed, or the copy is older than the pointer.
        threads.delete(threadId);
      }
      const missKey = `thread:${threadId}`;
      const missedUntil = misses.get(missKey);
      if (missedUntil !== undefined && missedUntil > Date.now()) return null;
      const startedAt = Date.now();
      const found = await client.byThread(threadId);
      if (!found) {
        rememberMiss(missKey);
        return null;
      }
      const conversation = apply(found.conversation, startedAt);
      const thread =
        conversation.threads.find(
          (candidate) => candidate.threadId === threadId,
        ) ?? found.thread;
      return { thread, conversation };
    },

    apply: (conversation) => apply(conversation),

    invalidate(id) {
      held.delete(id);
    },

    async create(draft, key = writeKey("conversation.create")) {
      return apply(await client.create(draft, key));
    },

    async update(id, version, changes, key = writeKey("conversation.update")) {
      return apply(await client.update(id, version, changes, key));
    },

    resync,

    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    onResync(listener) {
      resyncListeners.add(listener);
      return () => resyncListeners.delete(listener);
    },
  };
  return directory;
}

let installed: ConversationDirectory | undefined;

/** Make this the directory every conversation read and write in this process goes through. */
export function installConversationDirectory(
  directory: ConversationDirectory,
): ConversationDirectory {
  installed = directory;
  return directory;
}

/**
 * The conversations, as this process holds them. Throws when nothing installed a directory, rather
 * than answering that nobody has any conversations.
 */
export function conversations(): ConversationDirectory {
  if (!installed) {
    throw new Error(
      "No conversation directory is installed. The server installs one at boot (conversations/directory.ts); a test installs the one in tests/support/conversations.ts.",
    );
  }
  return installed;
}

export { ConversationMissingError };

/**
 * The channel a person's own thread is shown in, by the thread: what a lookup in
 * `intelligence_channel_mappings` answered. Null for a scratch thread, a Bot's thread in a group, or
 * (with `userId`) a thread that is somebody else's.
 */
export async function channelOfThread(
  threadId: string,
  userId?: string,
): Promise<string | null> {
  const found = await conversations().byThread(threadId);
  if (!found || found.thread.agentId !== null) return null;
  if (userId !== undefined && found.thread.userId !== userId) return null;
  return found.conversation.id;
}
