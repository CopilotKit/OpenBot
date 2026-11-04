/**
 * Intelligence's memories and memory sources, as OpenBot calls them: every memory and every memory source
 * is created, read, changed and removed here, under this deployment's project key. The contracts are
 * Intelligence's `docs/contracts/memories.md` and `docs/contracts/memory-sources.md`.
 *
 * Memory storage is on every Intelligence plan; only semantic (hybrid) recall is a paid feature, and recall
 * says which mode answered. Every call names the person (`X-Cpki-User-Id`) where the contract asks for one,
 * and asks for their own memories only:
 *
 * READ-WRITE ON USER, NONE ON PROJECT, ALWAYS. A project-scoped memory is shared by everyone in the
 * Intelligence project, so reading project scope here would hand one person's Bot another person's facts.
 *
 * Every write carries an `Idempotency-Key`, and a write that fails on the way (the connection drops,
 * Intelligence answers 5xx) is retried with the same key. Nothing here holds a database connection: a
 * caller must never call this with an OpenBot transaction open.
 */
import { randomUUID } from "node:crypto";

export type IntelligenceMemorySettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe or stub the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** A memory as Intelligence returns it. */
export type WireMemory = {
  id: string;
  kind: string;
  scope: string;
  content: string;
  sourceThreadIds: string[];
  invalidatedAt?: string | null;
  /** The memory a content change replaced this one with. */
  supersededBy?: string | null;
  agentId: string | null;
  reviewState: "unreviewed" | "confirmed" | "edited";
  enabled: boolean;
  provenance: string | null;
  formedBy: "person" | "import" | "agent" | null;
  /**
   * The Bot that formed it. Where it came from, not who may see it: a Bot-formed memory is for every
   * agent in Intelligence (`agentId` null), so once the person confirms it every other app on the
   * project reads it, as the mirror gave them before; OpenBot itself gives it only to this Bot.
   */
  formedByAgentId?: string | null;
  sourceId: string | null;
  externalId: string | null;
  contentDigest: string | null;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  observedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  score?: number;
  absorbed?: boolean;
  duplicate?: boolean;
  retiredId?: string;
};

/** A memory source as Intelligence returns it. */
export type WireMemorySource = {
  id: string;
  userId: string;
  agentId: string | null;
  connectorRef: string;
  title: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  syncStatus: "idle" | "running" | "succeeded" | "error";
  syncError: string | null;
  lastSyncAt: string | null;
  nextSyncAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** Metadata a memory write may set. */
export type MemoryWriteFields = {
  agentId?: string | null;
  reviewState?: "unreviewed" | "confirmed" | "edited";
  enabled?: boolean;
  provenance?: string | null;
  formedBy?: "person" | "import" | "agent" | null;
  formedByAgentId?: string | null;
  sourceId?: string | null;
  externalId?: string | null;
  contentDigest?: string | null;
  sourceApp?: string | null;
  sourceRef?: string | null;
  sourceLink?: string | null;
  observedAt?: string | null;
};

export type MemoryCreate = MemoryWriteFields & {
  id?: string;
  content: string;
  kind?: "topical" | "episodic" | "operational";
  createdAt?: string;
  updatedAt?: string;
  invalidatedAt?: string;
};

export type MemoryPatch = MemoryWriteFields & { content?: string };

export type SourceCreate = {
  id?: string;
  userId: string;
  agentId?: string | null;
  connectorRef: string;
  title: string;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  syncStatus?: WireMemorySource["syncStatus"];
  syncError?: string | null;
  lastSyncAt?: string | null;
  nextSyncAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SourcePatch = Partial<
  Pick<
    WireMemorySource,
    | "agentId"
    | "connectorRef"
    | "title"
    | "settings"
    | "enabled"
    | "syncStatus"
    | "syncError"
    | "lastSyncAt"
    | "nextSyncAt"
  >
>;

export type ImportRecord = {
  externalId: string;
  content: string;
  contentDigest: string;
  provenance?: string | null;
  sourceApp?: string | null;
  sourceRef?: string | null;
  sourceLink?: string | null;
  observedAt?: string | null;
};

/** Intelligence refused or could not answer. `code` is its error code when it sent one. */
export class MemoryIntelligenceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "MemoryIntelligenceError";
  }
}

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const GRANT = JSON.stringify({ user: "read-write", project: "none" });

/** A fresh key for one logical write. Retries of that write reuse it. */
export function memoryIdempotencyKey(operation: string): string {
  return `openbot:memory:${operation}:${randomUUID()}`;
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
      code?: unknown;
    };
    const code = body.error?.code ?? body.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

const pause = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, 200 * 2 ** (attempt - 1)));

export type IntelligenceMemory = ReturnType<typeof createIntelligenceMemory>;

export function createIntelligenceMemory(settings: IntelligenceMemorySettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: {
      userId?: string | null;
      body?: unknown;
      idempotencyKey?: string;
      ifMatch?: number;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (options.userId) {
      headers["x-cpki-user-id"] = options.userId;
      headers["x-cpki-memory-grant"] = GRANT;
    }
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    if (options.ifMatch !== undefined)
      headers["if-match"] = `"${options.ifMatch}"`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await send(`${base}${path}`, {
          method,
          headers,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // A 5xx is Intelligence failing, not refusing: a read is safe to repeat, and a write under the
        // same key is the same write. A write with no key is not repeated.
        const repeatable = method === "GET" || !!options.idempotencyKey;
        if (response.status >= 500 && repeatable && attempt < ATTEMPTS) {
          lastError = new MemoryIntelligenceError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            await errorCode(response),
          );
          await pause(attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        const repeatable = method === "GET" || !!options.idempotencyKey;
        if (!repeatable) break;
        if (attempt < ATTEMPTS) await pause(attempt);
      }
    }
    if (lastError instanceof MemoryIntelligenceError) throw lastError;
    throw new MemoryIntelligenceError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function refusal(response: Response, action: string): Promise<never> {
    const code = await errorCode(response);
    throw new MemoryIntelligenceError(
      `Intelligence refused to ${action}: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  const memoryPath = (id: string) => `/api/memories/${encodeURIComponent(id)}`;
  const sourcePath = (id: string) =>
    `/api/memory-sources/${encodeURIComponent(id)}`;

  /** Every page of a listing. There is no cap: the cursor decides the end. */
  async function walk<T>(
    path: string,
    query: URLSearchParams,
    field: "memories" | "sources",
    userId: string | null,
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams(query);
      if (cursor) params.set("cursor", cursor);
      const response = await request("GET", `${path}?${params}`, { userId });
      if (response.status !== 200) return refusal(response, `list ${field}`);
      const body = (await response.json()) as Record<string, unknown> & {
        nextCursor: string | null;
      };
      all.push(...((body[field] as T[] | undefined) ?? []));
      cursor = body.nextCursor;
    } while (cursor);
    return all;
  }

  return {
    /**
     * Every live memory of the person, in every review state, switched on or off, for every agent: what
     * OpenBot's own rules then decide over.
     */
    async allMemories(
      userId: string,
      options: { includeInvalidated?: boolean } = {},
    ): Promise<WireMemory[]> {
      const query = new URLSearchParams({
        reviewState: "any",
        enabled: "any",
        agentId: "*",
        limit: "200",
      });
      if (options.includeInvalidated) query.set("includeInvalidated", "true");
      return walk<WireMemory>("/api/memories", query, "memories", userId);
    },

    /** One memory of the person's, in any state, or null. */
    async getMemory(userId: string, id: string): Promise<WireMemory | null> {
      const response = await request("GET", memoryPath(id), { userId });
      if (response.status === 404 || response.status === 400) return null;
      if (response.status !== 200) return refusal(response, "read a memory");
      return (await response.json()) as WireMemory;
    },

    async createMemory(
      userId: string,
      input: MemoryCreate,
      key = memoryIdempotencyKey("create"),
    ): Promise<WireMemory> {
      const response = await request("POST", "/api/memories", {
        userId,
        body: { kind: "topical", scope: "user", ...input },
        idempotencyKey: key,
      });
      if (response.status !== 200 && response.status !== 201)
        return refusal(response, "create a memory");
      return (await response.json()) as WireMemory;
    },

    /**
     * Change a memory. With `content` Intelligence supersedes it: the answer is a new memory, and
     * `retiredId` names the one it replaced. Null when the memory is not live.
     */
    async updateMemory(
      userId: string,
      id: string,
      patch: MemoryPatch,
      key = memoryIdempotencyKey("update"),
    ): Promise<WireMemory | null> {
      const response = await request("PATCH", memoryPath(id), {
        userId,
        body: patch,
        idempotencyKey: key,
      });
      if (response.status === 404) return null;
      if (response.status !== 200) return refusal(response, "change a memory");
      return (await response.json()) as WireMemory;
    },

    /**
     * Forget a memory. `erase` blanks its words and keeps the tombstone. False when no live memory has
     * the id.
     */
    async forgetMemory(
      userId: string,
      id: string,
      options: { erase?: boolean; purge?: boolean } = {},
    ): Promise<boolean> {
      const query = options.purge
        ? "?purge=true"
        : options.erase
          ? "?erase=true"
          : "";
      const response = await request("DELETE", `${memoryPath(id)}${query}`, {
        userId,
        idempotencyKey: memoryIdempotencyKey("forget"),
      });
      if (response.status === 404) return false;
      if (response.status !== 204) return refusal(response, "forget a memory");
      return true;
    },

    /** Delete every memory of the person for good. */
    async purgePerson(userId: string): Promise<number> {
      const response = await request("DELETE", "/api/memories?all=true", {
        userId,
        idempotencyKey: memoryIdempotencyKey("purge-person"),
      });
      if (response.status !== 200)
        return refusal(response, "purge a person's memories");
      return ((await response.json()) as { deleted: number }).deleted;
    },

    /** Delete every memory scoped to a Bot, for everyone in the project. */
    async purgeAgent(agentId: string): Promise<number> {
      const response = await request(
        "DELETE",
        `/api/memories?agentId=${encodeURIComponent(agentId)}`,
        { idempotencyKey: memoryIdempotencyKey("purge-agent") },
      );
      if (response.status !== 200)
        return refusal(response, "purge a Bot's memories");
      return ((await response.json()) as { deleted: number }).deleted;
    },

    /** Ranked recall, with the mode Intelligence answered in. */
    async recall(
      userId: string,
      query: string,
      options: { limit: number; agentId?: string },
    ): Promise<{ memories: WireMemory[]; mode: "hybrid" | "keyword" }> {
      const response = await request("POST", "/api/memories/recall", {
        userId,
        body: {
          query,
          limit: options.limit,
          scope: "user",
          ...(options.agentId ? { agentId: options.agentId } : {}),
        },
      });
      if (response.status !== 200) return refusal(response, "recall");
      return (await response.json()) as {
        memories: WireMemory[];
        mode: "hybrid" | "keyword";
      };
    },

    /**
     * Upsert records from a source. Null when Intelligence has no such source of the person's or it is
     * switched off.
     */
    async importRecords(
      userId: string,
      sourceId: string,
      records: ImportRecord[],
      options: { reviewState?: "unreviewed" | "confirmed" } = {},
    ): Promise<{ externalId: string; id: string; outcome: string }[] | null> {
      const response = await request("POST", "/api/memories/import", {
        userId,
        body: { sourceId, records, ...options },
        idempotencyKey: memoryIdempotencyKey("import"),
      });
      if (response.status === 404 || response.status === 409) {
        const code = await errorCode(response);
        if (
          code === "MEMORY_SOURCE_NOT_FOUND" ||
          code === "MEMORY_SOURCE_DISABLED"
        )
          return null;
      }
      if (response.status !== 200) return refusal(response, "import records");
      return (
        (await response.json()) as {
          results: { externalId: string; id: string; outcome: string }[];
        }
      ).results;
    },

    /** Sources matching the filter, every page. */
    async sources(filter: {
      userId?: string;
      agentId?: string;
      enabled?: boolean;
      dueBefore?: Date;
      limit?: number;
    }): Promise<WireMemorySource[]> {
      const query = new URLSearchParams({ limit: "200" });
      if (filter.userId) query.set("userId", filter.userId);
      if (filter.agentId) query.set("agentId", filter.agentId);
      if (filter.enabled !== undefined)
        query.set("enabled", String(filter.enabled));
      if (filter.dueBefore)
        query.set("dueBefore", filter.dueBefore.toISOString());
      if (filter.limit !== undefined) {
        query.set("limit", String(filter.limit));
        const response = await request("GET", `/api/memory-sources?${query}`);
        if (response.status !== 200) return refusal(response, "list sources");
        return ((await response.json()) as { sources: WireMemorySource[] })
          .sources;
      }
      return walk<WireMemorySource>(
        "/api/memory-sources",
        query,
        "sources",
        null,
      );
    },

    async getSource(id: string): Promise<WireMemorySource | null> {
      const response = await request("GET", sourcePath(id));
      if (response.status === 404 || response.status === 400) return null;
      if (response.status !== 200) return refusal(response, "read a source");
      return (await response.json()) as WireMemorySource;
    },

    async createSource(
      input: SourceCreate,
      key = memoryIdempotencyKey("create-source"),
    ): Promise<WireMemorySource> {
      const response = await request("POST", "/api/memory-sources", {
        body: input,
        idempotencyKey: key,
      });
      if (response.status !== 200 && response.status !== 201)
        return refusal(response, "create a source");
      return (await response.json()) as WireMemorySource;
    },

    /**
     * Change a source at the version read. `stale` when it changed since; null when it is gone.
     */
    async updateSource(
      id: string,
      patch: SourcePatch,
      version: number,
    ): Promise<WireMemorySource | "stale" | null> {
      const response = await request("PATCH", sourcePath(id), {
        body: patch,
        ifMatch: version,
        idempotencyKey: memoryIdempotencyKey("update-source"),
      });
      if (response.status === 404) return null;
      if (response.status === 412) return "stale";
      if (response.status !== 200) return refusal(response, "change a source");
      return (await response.json()) as WireMemorySource;
    },

    /** Delete a source and, with it, every memory imported from it. False when it was already gone. */
    async deleteSource(id: string): Promise<boolean> {
      const response = await request("DELETE", sourcePath(id), {
        idempotencyKey: memoryIdempotencyKey("delete-source"),
      });
      if (response.status === 404) return false;
      if (response.status !== 204) return refusal(response, "delete a source");
      return true;
    },

    /** Delete every source of a person, or of a Bot, with their memories. */
    async purgeSources(filter: {
      userId?: string;
      agentId?: string;
    }): Promise<number> {
      const query = new URLSearchParams();
      if (filter.userId) query.set("userId", filter.userId);
      if (filter.agentId) query.set("agentId", filter.agentId);
      const response = await request("DELETE", `/api/memory-sources?${query}`, {
        idempotencyKey: memoryIdempotencyKey("purge-sources"),
      });
      if (response.status !== 200) return refusal(response, "purge sources");
      return ((await response.json()) as { deleted: number }).deleted;
    },
  };
}
