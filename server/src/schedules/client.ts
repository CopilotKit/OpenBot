/**
 * Intelligence's agent schedules, as OpenBot calls them: routines, check-ins and responsibilities,
 * and their history, created, read, changed and deleted under this deployment's project key. The
 * contract is Intelligence's `docs/contracts/agent-schedules.md`.
 *
 * Every write carries an `Idempotency-Key`, and a write that fails on the way (the connection drops,
 * Intelligence answers 5xx) is retried with the same key, so a retry after a lost response is the
 * same write rather than a second one. Nothing here holds a database connection: a caller must never
 * call this with an OpenBot transaction open.
 */
import {
  DATE_FIELDS,
  type ScheduleChanges,
  type ScheduleCollection,
  type ScheduleCollections,
  type ScheduleDraft,
  type ScheduleFilter,
} from "./types";

export type ScheduleClientSettings = {
  apiUrl: string;
  apiKey: string;
  /** For tests that need to observe the transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** Intelligence refused or could not answer. `code` is its error code when it sent one. */
export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ScheduleError";
  }
}

/** No such record: never created, or deleted for good. */
export class ScheduleNotFoundError extends ScheduleError {
  constructor(collection: string, id: string) {
    super(
      `No ${collection} record ${id} in Intelligence.`,
      404,
      "SCHEDULE_NOT_FOUND",
    );
    this.name = "ScheduleNotFoundError";
  }
}

/** A record with this id already exists, live or deleted. */
export class ScheduleAlreadyExistsError extends ScheduleError {
  constructor(collection: string, id: string) {
    super(
      `A ${collection} record ${id} already exists.`,
      409,
      "SCHEDULE_ALREADY_EXISTS",
    );
    this.name = "ScheduleAlreadyExistsError";
  }
}

/**
 * A unique rule refused the write: one open item per title, one running check-in per setting, one
 * event per source id. `existingId` names the record that holds the place, when Intelligence says.
 */
export class ScheduleConflictError extends ScheduleError {
  constructor(
    message: string,
    readonly constraint: string | null,
    readonly existingId: string | null,
    details: Record<string, unknown>,
  ) {
    super(message, 409, "SCHEDULE_CONFLICT", details);
    this.name = "ScheduleConflictError";
  }
}

/** The record changed since it was read. Read it again and redo the change. */
export class ScheduleVersionConflictError extends ScheduleError {
  constructor(collection: string, id: string) {
    super(
      `${collection} record ${id} changed since it was read.`,
      412,
      "SCHEDULE_VERSION_CONFLICT",
    );
    this.name = "ScheduleVersionConflictError";
  }
}

/** The record is soft-deleted, so it cannot be changed. */
export class ScheduleDeletedError extends ScheduleError {
  constructor(collection: string, id: string) {
    super(`${collection} record ${id} is deleted.`, 409, "SCHEDULE_DELETED");
    this.name = "ScheduleDeletedError";
  }
}

/** The person's hourly ping slot was taken first, or is not free yet. */
export class CheckInSlotTakenError extends ScheduleError {
  constructor(ownerUserId: string) {
    super(
      `The ping slot for ${ownerUserId} is taken.`,
      409,
      "CHECK_IN_SLOT_TAKEN",
    );
    this.name = "CheckInSlotTakenError";
  }
}

/** An item a ping was to carry was resolved or carried by another ping in the meantime. */
export class CheckInItemsChangedError extends ScheduleError {
  constructor(ownerUserId: string) {
    super(
      `The items waiting for ${ownerUserId} changed.`,
      409,
      "CHECK_IN_ITEMS_CHANGED",
    );
    this.name = "CheckInItemsChangedError";
  }
}

export type SchedulePage<C extends ScheduleCollection> = {
  items: ScheduleCollections[C][];
  nextCursor: string | null;
  joinCode: string | null;
};

export type CheckInRunSummaryRow = {
  agentId: string;
  outcome: string;
  skipReason: string | null;
  count: number;
};

export type CheckInSuggestionSummaryRow = {
  agentId: string;
  status: string;
  count: number;
  delivered: number;
};

export type CheckInPingSummary = {
  pings: number;
  people: number;
  itemsPerPing: number | null;
};

export type TakePingInput = {
  id: string;
  ownerUserId: string;
  gapMinutes: number;
  suggestionIds: string[];
  text: string;
  pushBody: string;
};

export type ScheduleClient = ReturnType<typeof createScheduleClient>;

const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const IMPORT_BATCH = 500;

/** A fresh key for one logical write. Retries of that write reuse it. */
export function scheduleIdempotencyKey(operation: string): string {
  return `openbot:${operation}:${crypto.randomUUID()}`;
}

export function createScheduleClient(settings: ScheduleClientSettings) {
  const base = settings.apiUrl.replace(/\/+$/, "");
  const send = settings.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      ifMatch?: number;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    };
    if (options.body !== undefined)
      headers["content-type"] = "application/json";
    if (options.idempotencyKey)
      headers["idempotency-key"] = options.idempotencyKey;
    if (options.ifMatch !== undefined)
      headers["if-match"] = `"${options.ifMatch}"`;
    // A body-carrying write without a key of its own still gets one, so the retries below are the
    // same write and not a second one.
    if (
      options.body !== undefined &&
      method !== "GET" &&
      !headers["idempotency-key"]
    )
      headers["idempotency-key"] = scheduleIdempotencyKey("write");
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
        // A 5xx is Intelligence failing, not refusing: the same write under the same key is safe to
        // send again, and a read is safe to repeat.
        if (response.status >= 500 && attempt < ATTEMPTS) {
          const { code } = await errorOf(response);
          lastError = new ScheduleError(
            `Intelligence answered ${response.status} to ${method} ${path}.`,
            response.status,
            code,
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
    if (lastError instanceof ScheduleError) throw lastError;
    throw new ScheduleError(
      `Could not reach Intelligence for ${method} ${path}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      null,
      null,
    );
  }

  async function refusal(
    response: Response,
    collection: string,
    id: string,
    action: string,
  ): Promise<never> {
    const { code, message, details } = await errorOf(response);
    if (response.status === 404)
      throw new ScheduleNotFoundError(collection, id);
    if (response.status === 412)
      throw new ScheduleVersionConflictError(collection, id);
    if (code === "SCHEDULE_ALREADY_EXISTS")
      throw new ScheduleAlreadyExistsError(collection, id);
    if (code === "SCHEDULE_DELETED")
      throw new ScheduleDeletedError(collection, id);
    if (code === "SCHEDULE_CONFLICT")
      throw new ScheduleConflictError(
        message ?? `Intelligence refused ${collection} ${id}: a unique rule.`,
        typeof details.constraint === "string" ? details.constraint : null,
        typeof details.existingId === "string" ? details.existingId : null,
        details,
      );
    if (code === "CHECK_IN_SLOT_TAKEN") throw new CheckInSlotTakenError(id);
    if (code === "CHECK_IN_ITEMS_CHANGED")
      throw new CheckInItemsChangedError(id);
    throw new ScheduleError(
      `Intelligence refused to ${action} ${collection} ${id}: ${response.status}${code ? ` ${code}` : ""}${message ? ` (${message})` : ""}.`,
      response.status,
      code,
      details,
    );
  }

  const collectionPath = (collection: ScheduleCollection) =>
    `/api/schedules/${collection}`;
  const recordPath = (collection: ScheduleCollection, id: string) =>
    `${collectionPath(collection)}/${encodeURIComponent(id)}`;

  async function recordFrom<C extends ScheduleCollection>(
    collection: C,
    response: Response,
  ): Promise<ScheduleCollections[C]> {
    return fromWire(
      collection,
      (await response.json()) as Record<string, unknown>,
    );
  }

  const client = {
    async create<C extends ScheduleCollection>(
      collection: C,
      draft: ScheduleDraft<C>,
      key: string = scheduleIdempotencyKey(`create:${collection}`),
    ): Promise<ScheduleCollections[C]> {
      const response = await request("POST", collectionPath(collection), {
        body: toWire(draft as Record<string, unknown>),
        idempotencyKey: key,
      });
      if (response.status !== 201 && response.status !== 200)
        return refusal(response, collection, draft.id, "create");
      return recordFrom(collection, response);
    },

    /**
     * Copy whole records in, history included, for an upgrade. Records already there are left as
     * they are. Returns how many of the ids sent Intelligence now holds.
     */
    async importRecords<C extends ScheduleCollection>(
      collection: C,
      records: readonly Record<string, unknown>[],
    ): Promise<number> {
      let stored = 0;
      for (let start = 0; start < records.length; start += IMPORT_BATCH) {
        const batch = records.slice(start, start + IMPORT_BATCH);
        const response = await request(
          "POST",
          `${collectionPath(collection)}/import`,
          { body: { records: batch.map((record) => toWire(record)) } },
        );
        if (response.status !== 200)
          return refusal(response, collection, "*", "import into");
        stored += ((await response.json()) as { stored: number }).stored;
      }
      return stored;
    },

    /** The record, deleted ones included, or null when Intelligence has no such record. */
    async get<C extends ScheduleCollection>(
      collection: C,
      id: string,
    ): Promise<ScheduleCollections[C] | null> {
      const response = await request(
        "GET",
        `${recordPath(collection, id)}?includeDeleted=true`,
      );
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refusal(response, collection, id, "read");
      return recordFrom(collection, response);
    },

    async page<C extends ScheduleCollection>(
      collection: C,
      filter: ScheduleFilter = {},
      cursor: string | null = null,
      limit = 500,
    ): Promise<SchedulePage<C>> {
      const query = queryOf(filter);
      query.set("limit", String(limit));
      if (cursor) query.set("cursor", cursor);
      const response = await request(
        "GET",
        `${collectionPath(collection)}?${query}`,
      );
      if (response.status !== 200)
        return refusal(response, collection, "*", "list");
      const body = (await response.json()) as {
        items: Record<string, unknown>[];
        nextCursor: string | null;
        joinCode?: string | null;
      };
      return {
        items: body.items.map((item) => fromWire(collection, item)),
        nextCursor: body.nextCursor,
        joinCode: body.joinCode ?? null,
      };
    },

    /** Every record matching the filter, walking every page. There is no cap: the cursor decides the end. */
    async all<C extends ScheduleCollection>(
      collection: C,
      filter: ScheduleFilter = {},
    ): Promise<{ items: ScheduleCollections[C][]; joinCode: string | null }> {
      const items: ScheduleCollections[C][] = [];
      let cursor: string | null = null;
      let joinCode: string | null = null;
      do {
        const page: SchedulePage<C> = await client.page(
          collection,
          filter,
          cursor,
        );
        items.push(...page.items);
        joinCode = page.joinCode ?? joinCode;
        cursor = page.nextCursor;
      } while (cursor);
      return { items, joinCode };
    },

    async update<C extends ScheduleCollection>(
      collection: C,
      id: string,
      version: number,
      changes: ScheduleChanges<C>,
      key: string = scheduleIdempotencyKey(`update:${collection}`),
    ): Promise<ScheduleCollections[C]> {
      const response = await request("PATCH", recordPath(collection, id), {
        body: toWire(changes as Record<string, unknown>),
        ifMatch: version,
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refusal(response, collection, id, "change");
      return recordFrom(collection, response);
    },

    /** Soft delete. Deleting a record that is already deleted returns it unchanged. */
    async remove<C extends ScheduleCollection>(
      collection: C,
      id: string,
      key: string = scheduleIdempotencyKey(`delete:${collection}`),
      version?: number,
    ): Promise<ScheduleCollections[C]> {
      const response = await request("DELETE", recordPath(collection, id), {
        idempotencyKey: key,
        ...(version === undefined ? {} : { ifMatch: version }),
      });
      if (response.status !== 200)
        return refusal(response, collection, id, "delete");
      return recordFrom(collection, response);
    },

    /** Delete for good. True when this call removed it, false when it was already gone. */
    async purge(
      collection: ScheduleCollection,
      id: string,
      key: string = scheduleIdempotencyKey(`purge:${collection}`),
    ): Promise<boolean> {
      const response = await request(
        "DELETE",
        `${recordPath(collection, id)}?purge=true`,
        { idempotencyKey: key },
      );
      if (response.status === 404) return false;
      if (response.status !== 204 && response.status !== 200)
        return refusal(response, collection, id, "purge");
      return true;
    },

    /**
     * The sweep's compare-and-set: move a routine's or a check-in's clock from `from` to `to`. Null
     * when another replica moved it first, or the record is gone or switched off.
     */
    async advance<C extends "routines" | "check-in-settings">(
      collection: C,
      id: string,
      from: Date,
      to: Date,
    ): Promise<ScheduleCollections[C] | null> {
      const response = await request(
        "POST",
        `${recordPath(collection, id)}/advance`,
        { body: { from: from.toISOString(), to: to.toISOString() } },
      );
      if (response.status === 200) return recordFrom(collection, response);
      const { code } = await errorOf(response);
      if (
        code === "SCHEDULE_CLOCK_MOVED" ||
        response.status === 404 ||
        code === "SCHEDULE_DELETED"
      )
        return null;
      return refusal(response, collection, id, "advance");
    },

    /** The newest run of each routine named, at most one each. */
    async latestRoutineRuns(
      routineIds: readonly string[],
    ): Promise<ScheduleCollections["routine-runs"][]> {
      if (routineIds.length === 0) return [];
      const runs: ScheduleCollections["routine-runs"][] = [];
      for (let start = 0; start < routineIds.length; start += 200) {
        const query = new URLSearchParams({
          routineIds: routineIds.slice(start, start + 200).join(","),
        });
        const response = await request(
          "GET",
          `${collectionPath("routine-runs")}/latest?${query}`,
        );
        if (response.status !== 200)
          return refusal(response, "routine-runs", "*", "list");
        const body = (await response.json()) as {
          items: Record<string, unknown>[];
        };
        runs.push(...body.items.map((item) => fromWire("routine-runs", item)));
      }
      return runs;
    },

    /**
     * Take a person's ping slot and write the ping that folds their waiting items, in one step on
     * Intelligence's side. Throws CheckInSlotTakenError or CheckInItemsChangedError when it cannot.
     */
    async takePing(
      input: TakePingInput,
    ): Promise<ScheduleCollections["check-in-pings"]> {
      const response = await request(
        "POST",
        `${collectionPath("check-in-pings")}/take`,
        { body: input, idempotencyKey: `openbot:ping:${input.id}` },
      );
      if (response.status !== 201 && response.status !== 200)
        return refusal(response, "check-in-pings", input.ownerUserId, "take");
      const body = (await response.json()) as Record<string, unknown>;
      // Either the ping itself or `{ ping }`, whichever the contract settled on.
      const ping = (body.ping as Record<string, unknown> | undefined) ?? body;
      return fromWire("check-in-pings", ping);
    },

    async checkInRunSummary(
      since: Date,
      agentIds?: readonly string[],
    ): Promise<CheckInRunSummaryRow[]> {
      return summary("check-in-runs", since, agentIds) as Promise<
        CheckInRunSummaryRow[]
      >;
    },

    async checkInSuggestionSummary(
      since: Date,
      agentIds?: readonly string[],
    ): Promise<CheckInSuggestionSummaryRow[]> {
      return summary("check-in-suggestions", since, agentIds) as Promise<
        CheckInSuggestionSummaryRow[]
      >;
    },

    /**
     * Pings delivery was offered since `since`: how many, to how many people, and how many items each
     * carried on average (null when there were none).
     */
    async checkInPingSummary(since: Date): Promise<CheckInPingSummary> {
      const query = new URLSearchParams({ since: since.toISOString() });
      const response = await request(
        "GET",
        `${collectionPath("check-in-pings")}/summary?${query}`,
      );
      if (response.status !== 200)
        return refusal(response, "check-in-pings", "*", "summarize");
      return (await response.json()) as CheckInPingSummary;
    },

    /** Remove finished history older than `before`. Returns how many records went. */
    async prune(
      collection: "check-in-runs" | "check-in-pings",
      before: Date,
    ): Promise<number> {
      const response = await request(
        "POST",
        `${collectionPath(collection)}/prune`,
        { body: { before: before.toISOString() } },
      );
      if (response.status !== 200)
        return refusal(response, collection, "*", "prune");
      return ((await response.json()) as { deleted: number }).deleted;
    },

    /** Purge everything this person owns across every collection: a person removed for good. */
    async purgeOwner(ownerUserId: string): Promise<Record<string, number>> {
      return purgeBy("by-owner", ownerUserId);
    },

    /** Purge everything this Bot has across every collection: a Bot deleted for good. */
    async purgeAgent(agentId: string): Promise<Record<string, number>> {
      return purgeBy("by-agent", agentId);
    },

    /** Credentials for the realtime topic that announces every change to the announced collections. */
    async subscribe(): Promise<{ joinToken: string; joinCode: string }> {
      const response = await request("POST", "/api/schedules/subscribe", {
        body: {},
      });
      if (response.status !== 200)
        return refusal(response, "routines", "*", "subscribe to");
      return (await response.json()) as { joinToken: string; joinCode: string };
    },
  };

  async function summary(
    collection: ScheduleCollection,
    since: Date,
    agentIds?: readonly string[],
  ): Promise<unknown[]> {
    const query = new URLSearchParams({ since: since.toISOString() });
    if (agentIds && agentIds.length > 0)
      query.set("agentIds", agentIds.join(","));
    const response = await request(
      "GET",
      `${collectionPath(collection)}/summary?${query}`,
    );
    if (response.status !== 200)
      return refusal(response, collection, "*", "summarize");
    const body = (await response.json()) as
      | { rows?: unknown[]; items?: unknown[] }
      | unknown[];
    if (Array.isArray(body)) return body;
    return body.rows ?? body.items ?? [];
  }

  async function purgeBy(
    kind: "by-owner" | "by-agent",
    id: string,
  ): Promise<Record<string, number>> {
    const response = await request(
      "DELETE",
      `/api/schedules/${kind}/${encodeURIComponent(id)}?purge=true`,
      { idempotencyKey: scheduleIdempotencyKey(`purge-${kind}`) },
    );
    if (response.status !== 200 && response.status !== 204)
      return refusal(response, "routines", id, `purge ${kind}`);
    if (response.status === 204) return {};
    const body = (await response.json()) as {
      purged?: Record<string, number>;
    };
    return body.purged ?? (body as Record<string, number>);
  }

  return client;
}

function queryOf(filter: ScheduleFilter): URLSearchParams {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (value === null) query.set(name, "null");
    else if (value instanceof Date) query.set(name, value.toISOString());
    else if (Array.isArray(value)) query.set(name, value.join(","));
    else query.set(name, String(value));
  }
  return query;
}

function toWire(record: Record<string, unknown>): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record)) {
    if (value === undefined) continue;
    wire[name] = value instanceof Date ? value.toISOString() : value;
  }
  return wire;
}

function fromWire<C extends ScheduleCollection>(
  collection: C,
  wire: Record<string, unknown>,
): ScheduleCollections[C] {
  const record: Record<string, unknown> = { ...wire };
  for (const name of ["createdAt", "updatedAt", ...DATE_FIELDS[collection]]) {
    const value = record[name];
    if (typeof value === "string") record[name] = new Date(value);
  }
  return record as ScheduleCollections[C];
}

async function errorOf(response: Response): Promise<{
  code: string | null;
  message: string | null;
  details: Record<string, unknown>;
}> {
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    const details = body.error?.details;
    return {
      code: typeof body.error?.code === "string" ? body.error.code : null,
      message:
        typeof body.error?.message === "string" ? body.error.message : null,
      details:
        details && typeof details === "object"
          ? (details as Record<string, unknown>)
          : {},
    };
  } catch {
    return { code: null, message: null, details: {} };
  }
}

function pause(attempt: number) {
  return new Promise((resolve) => setTimeout(resolve, 150 * attempt * attempt));
}
