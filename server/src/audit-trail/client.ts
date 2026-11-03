/**
 * Intelligence's audit trail and model usage, as OpenBot calls them, under this deployment's project
 * key. The contracts are Intelligence's `docs/contracts/audit-trail.md` and
 * `docs/contracts/model-usage.md`.
 *
 * Writes are batches of records whose ids OpenBot chose when it wrote them, so sending a batch again
 * is the same write: Intelligence stores each id once and answers how many of the ids it now holds.
 * Nothing here holds a database connection: a caller must never call this with an OpenBot transaction
 * open.
 */

export type AuditTrailSettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe or stub the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is its error code when it sent one. */
export class AuditTrailClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "AuditTrailClientError";
  }

  /** Intelligence read the request and refused it: sending it again unchanged cannot succeed. */
  get refused(): boolean {
    return this.status === 400;
  }
}

/** An audit event as Intelligence takes it. */
export type WireAuditEvent = {
  id: string;
  occurredAt: string;
  eventType: string;
  actorUserId: string | null;
  initiator: { kind: string; id: string | null };
  target: { type: string; id: string | null };
  payload: Record<string, unknown>;
};

/** An audit event as Intelligence returns it. */
export type StoredAuditEvent = WireAuditEvent & { recordedAt: string };

export type WireActionRecord = {
  id: string;
  occurredAt: string;
  surface: "cloud" | "local";
  agentId: string | null;
  actorUserId: string | null;
  toolName: string;
  command: string;
  outcome: string;
};

export type WireModelUsage = {
  id: string;
  occurredAt: string;
  userId: string | null;
  agentId: string;
  threadId: string | null;
  runId: string | null;
  model: string;
  source: "configured" | "observed" | "unknown";
  allowed: boolean;
};

export type AuditEventFilter = {
  limit?: number;
  cursor?: string;
  /** Any of these types. */
  eventType?: readonly string[];
  eventTypePrefix?: string;
  actorUserId?: string;
  initiatorKind?: readonly string[];
  initiatorId?: string;
  targetType?: string;
  targetId?: string;
  /** RFC 3339, exclusive. */
  from?: string;
  /** RFC 3339, exclusive. */
  to?: string;
};

export type RetentionSettings = {
  eventRetentionDays: number | null;
  actionRetentionDays: number;
  version: number;
};

export type ModelUsageSummaryRow = {
  model: string;
  source: string;
  runs: number;
  refused: number;
  people: number;
  lastUsedAt: string;
};

/** The kinds of record a batch carries, by the path that takes it. */
export type RecordKind = "event" | "action" | "usage";

export type AuditTrailClient = ReturnType<typeof createAuditTrailClient>;

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

const BATCH_PATHS: Record<RecordKind, { path: string; key: string }> = {
  event: { path: "/api/audit/events", key: "events" },
  action: { path: "/api/audit/actions", key: "actions" },
  usage: { path: "/api/model-usage", key: "records" },
};

export function createAuditTrailClient(settings: AuditTrailSettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    options: { body?: unknown; ifMatch?: number } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
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
        // A 5xx is Intelligence failing, not refusing: every request here is safe to send again.
        if (response.status >= 500 && attempt < ATTEMPTS) {
          lastError = new AuditTrailClientError(
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
        if (attempt < ATTEMPTS) await pause(attempt);
      }
    }
    if (lastError instanceof AuditTrailClientError) throw lastError;
    throw new AuditTrailClientError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function refusal(response: Response, action: string): Promise<never> {
    const code = await errorCode(response);
    throw new AuditTrailClientError(
      `Intelligence refused to ${action}: ${response.status}${code ? ` ${code}` : ""}.`,
      response.status,
      code,
    );
  }

  async function json<T>(response: Response, action: string): Promise<T> {
    if (response.status !== 200) return refusal(response, action);
    return (await response.json()) as T;
  }

  return {
    /**
     * Store one batch of one kind. Answers how many of the batch's ids Intelligence now holds, so a
     * caller that sent `n` and reads `n` knows every one is stored.
     */
    async store(
      kind: RecordKind,
      records: readonly (WireAuditEvent | WireActionRecord | WireModelUsage)[],
    ): Promise<number> {
      const { path, key } = BATCH_PATHS[kind];
      const response = await request("POST", path, {
        body: { [key]: records },
      });
      const body = await json<{ stored: number }>(
        response,
        `store ${records.length} ${kind} records`,
      );
      return body.stored;
    },

    async events(
      filter: AuditEventFilter = {},
    ): Promise<{ events: StoredAuditEvent[]; nextCursor: string | null }> {
      const query = new URLSearchParams();
      if (filter.limit !== undefined) query.set("limit", String(filter.limit));
      if (filter.cursor) query.set("cursor", filter.cursor);
      if (filter.eventType) query.set("eventType", filter.eventType.join(","));
      if (filter.eventTypePrefix)
        query.set("eventTypePrefix", filter.eventTypePrefix);
      if (filter.actorUserId) query.set("actorUserId", filter.actorUserId);
      if (filter.initiatorKind)
        query.set("initiatorKind", filter.initiatorKind.join(","));
      if (filter.initiatorId) query.set("initiatorId", filter.initiatorId);
      if (filter.targetType) query.set("targetType", filter.targetType);
      if (filter.targetId) query.set("targetId", filter.targetId);
      if (filter.from) query.set("from", filter.from);
      if (filter.to) query.set("to", filter.to);
      return json(
        await request("GET", `/api/audit/events?${query}`),
        "list audit events",
      );
    },

    async actions(
      filter: { limit?: number; cursor?: string; agentId?: string } = {},
    ): Promise<{
      actions: (WireActionRecord & { recordedAt: string })[];
      nextCursor: string | null;
    }> {
      const query = new URLSearchParams();
      if (filter.limit !== undefined) query.set("limit", String(filter.limit));
      if (filter.cursor) query.set("cursor", filter.cursor);
      if (filter.agentId) query.set("agentId", filter.agentId);
      return json(
        await request("GET", `/api/audit/actions?${query}`),
        "list action records",
      );
    },

    async settings(): Promise<RetentionSettings> {
      return json(
        await request("GET", "/api/audit/settings"),
        "read audit settings",
      );
    },

    /** Replace both windows, only if the settings are still at `version`. Null on a version conflict. */
    async putSettings(
      version: number,
      settings: Omit<RetentionSettings, "version">,
    ): Promise<RetentionSettings | null> {
      const response = await request("PUT", "/api/audit/settings", {
        body: settings,
        ifMatch: version,
      });
      if (response.status === 412) return null;
      return json(response, "save audit settings");
    },

    async usage(
      filter: {
        limit?: number;
        cursor?: string;
        agentId?: string;
        userId?: string;
      } = {},
    ): Promise<{
      records: (WireModelUsage & { recordedAt: string })[];
      nextCursor: string | null;
    }> {
      const query = new URLSearchParams();
      if (filter.limit !== undefined) query.set("limit", String(filter.limit));
      if (filter.cursor) query.set("cursor", filter.cursor);
      if (filter.agentId) query.set("agentId", filter.agentId);
      if (filter.userId) query.set("userId", filter.userId);
      return json(
        await request("GET", `/api/model-usage?${query}`),
        "list model usage",
      );
    },

    async usageSummary(since: string): Promise<ModelUsageSummaryRow[]> {
      const body = await json<{ models: ModelUsageSummaryRow[] }>(
        await request(
          "GET",
          `/api/model-usage/summary?${new URLSearchParams({ since })}`,
        ),
        "summarize model usage",
      );
      return body.models;
    },
  };
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}
