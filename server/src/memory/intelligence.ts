import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";

/**
 * The slice of the Intelligence client memory needs. Typed from the client OpenBot already uses, so a
 * test can hand in a fake without standing up the platform.
 */
export type IntelligenceMemoryClient = Pick<
  CopilotKitIntelligence,
  | "getRuntimeEntitlements"
  | "listMemories"
  | "createMemory"
  | "updateMemory"
  | "removeMemory"
  | "recallMemories"
>;

/** A memory as Intelligence holds it: the person's own (`scope: "user"`), and live. */
export type IntelligenceMemoryRecord = {
  id: string;
  content: string;
  score?: number;
};

/**
 * Every call names the person and asks for their own memories only.
 *
 * READ-WRITE ON USER, NONE ON PROJECT, ALWAYS. A project-scoped memory is shared by everyone in the
 * Intelligence project, so reading project scope here would hand one person's Bot another person's
 * facts. Results are also filtered to `scope === "user"` after they arrive, so a platform that
 * ignored the grant still could not leak project rows into a person's memory.
 */
const GRANT = { user: "read-write", project: "none" } as const;
const KIND = "topical";

/** How long a known answer about whether memory is available is reused. */
const AVAILABLE_TTL_MS = 10 * 60_000;
/** How long a failure holds memory on the local store before Intelligence is asked again. */
const FAILURE_TTL_MS = 60_000;
/**
 * How long a person's list is reused. Every turn reads it for the memory context, so without this
 * each turn would wait on a platform round trip. Any write of that person's through this client
 * clears it, so OpenBot's own changes show at once; a memory another app adds shows within this.
 */
const LIST_TTL_MS = 30_000;

export type IntelligenceMemory = {
  /** Whether Intelligence memory is entitled and reachable right now. Never throws. */
  available(): Promise<boolean>;
  /** The person's live memories, newest first, at most the platform's list limit (200). */
  list(userId: string): Promise<IntelligenceMemoryRecord[] | undefined>;
  /** Ranked recall over the person's memories. */
  recall(
    userId: string,
    query: string,
    limit: number,
  ): Promise<IntelligenceMemoryRecord[] | undefined>;
  /** Store content; the id may be an existing memory's when Intelligence absorbed a near-duplicate. */
  create(userId: string, content: string): Promise<string | undefined>;
  /** Replace a memory's content. Intelligence retires the old row, so the id changes. */
  supersede(
    userId: string,
    id: string,
    content: string,
  ): Promise<string | undefined | "gone">;
  /** Retire a memory. True when it is gone, whether this call or an earlier one retired it. */
  remove(userId: string, id: string): Promise<boolean>;
};

function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

/**
 * Intelligence memory behind one guard: entitled, reachable, or out of the way.
 *
 * Memory is a licensed Intelligence feature, and OpenBot has to work without it. So every call here
 * answers `undefined` instead of throwing when the deployment is not entitled, Intelligence is
 * unreachable, or a call fails; the store then keeps working on its own tables. A `403` (the
 * platform's `MEMORY_NOT_ENTITLED`), a `401` or a network failure holds memory on the local store
 * for a minute before asking again, so a lapsed licence costs one failed call a minute, not one per
 * turn.
 */
export function createIntelligenceMemory(options: {
  client: IntelligenceMemoryClient;
  now?: () => number;
  log?: (message: string) => void;
}): IntelligenceMemory {
  const { client } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  let state: { available: boolean; until: number } | undefined;
  let loggedUnavailable = false;
  const lists = new Map<
    string,
    { memories: IntelligenceMemoryRecord[]; until: number }
  >();

  const hold = (reason: string) => {
    state = { available: false, until: now() + FAILURE_TTL_MS };
    if (!loggedUnavailable) {
      loggedUnavailable = true;
      log(
        JSON.stringify({
          type: "intelligence-memory-unavailable",
          reason,
          timestamp: new Date(now()).toISOString(),
        }),
      );
    }
  };

  async function available(): Promise<boolean> {
    if (state && state.until > now()) return state.available;
    try {
      const response = await client.getRuntimeEntitlements();
      const entitled =
        response.status === "ready" &&
        response.entitlement.active &&
        response.entitlement.features.memory === true;
      state = {
        available: entitled,
        until: now() + (entitled ? AVAILABLE_TTL_MS : FAILURE_TTL_MS),
      };
      if (entitled) loggedUnavailable = false;
      else if (!loggedUnavailable) hold("not entitled");
      return entitled;
    } catch (error) {
      hold(error instanceof Error ? error.name : "entitlement read failed");
      return false;
    }
  }

  async function guarded<T>(
    operation: string,
    call: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!(await available())) return undefined;
    try {
      return await call();
    } catch (error) {
      const status = statusOf(error);
      if (status === undefined || status === 401 || status === 403)
        hold(
          `${operation}: ${status ?? (error instanceof Error ? error.name : "failed")}`,
        );
      else
        log(
          JSON.stringify({
            type: "intelligence-memory-error",
            operation,
            status,
            timestamp: new Date(now()).toISOString(),
          }),
        );
      throw error;
    }
  }

  const live = (
    memories: {
      id: string;
      scope: string;
      content: string;
      invalidatedAt: string | null;
      score?: number;
    }[],
  ): IntelligenceMemoryRecord[] =>
    memories
      .filter((memory) => memory.scope === "user" && !memory.invalidatedAt)
      .map((memory) => ({
        id: memory.id,
        content: memory.content,
        ...(memory.score === undefined ? {} : { score: memory.score }),
      }));

  return {
    available,
    async list(userId) {
      const cached = lists.get(userId);
      if (cached && cached.until > now() && (await available()))
        return cached.memories;
      try {
        const response = await guarded("list", () =>
          client.listMemories({ userId, memoryGrant: GRANT }),
        );
        if (!response) return undefined;
        const memories = live(response.memories);
        lists.set(userId, { memories, until: now() + LIST_TTL_MS });
        return memories;
      } catch {
        return undefined;
      }
    },
    async recall(userId, query, limit) {
      try {
        const response = await guarded("recall", () =>
          client.recallMemories({
            userId,
            memoryGrant: GRANT,
            query,
            limit,
            scope: "user",
          }),
        );
        return response ? live(response.memories) : undefined;
      } catch {
        return undefined;
      }
    },
    async create(userId, content) {
      lists.delete(userId);
      try {
        const saved = await guarded("create", () =>
          client.createMemory({
            userId,
            memoryGrant: GRANT,
            content,
            kind: KIND,
            scope: "user",
          }),
        );
        return saved?.id;
      } catch {
        return undefined;
      }
    },
    async supersede(userId, id, content) {
      lists.delete(userId);
      try {
        const saved = await guarded("supersede", () =>
          client.updateMemory({
            userId,
            memoryGrant: GRANT,
            id,
            content,
            kind: KIND,
            scope: "user",
          }),
        );
        return saved?.id;
      } catch (error) {
        // The row it named was already retired, by the person in another app or an earlier attempt.
        return statusOf(error) === 404 ? "gone" : undefined;
      }
    },
    async remove(userId, id) {
      lists.delete(userId);
      try {
        const done = await guarded("remove", async () => {
          await client.removeMemory({ userId, id, memoryGrant: GRANT });
          return true;
        });
        return done === true;
      } catch (error) {
        return statusOf(error) === 404;
      }
    },
  };
}
