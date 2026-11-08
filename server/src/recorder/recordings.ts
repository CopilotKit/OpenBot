import type {
  RecordingRow,
  RecordingsPage,
} from "@openbot/shared/recorder-api";

export type TrajectorySummary = {
  trajectoryId: string;
  createdAt: string;
  firstEventAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  workflow: string | null;
  outcome: {
    phase: "started" | "succeeded" | "failed";
    reason: string | null;
  } | null;
};

/**
 * Read the summaries of recordings (trajectories) from Intelligence with the runtime key.
 *
 * 404, 403 and any other 4xx but 408 and 429 mean this Intelligence has no such route or will not let
 * the key read it, and asking again will not change that, so recordings are `unavailable`. Nothing
 * answering, a 5xx, a 408 or 429, or any answer that is not a list is `unreachable`, which may pass
 * in a moment. Every failure is logged (status only, never the key). An item that is not a summary
 * is dropped.
 */
export async function fetchTrajectorySummaries(input: {
  apiUrl: string;
  apiKey: string;
  fetch: typeof fetch;
  ids: string[];
}): Promise<
  | { items: TrajectorySummary[] }
  | { unavailable: "unavailable" | "unreachable" }
> {
  if (input.ids.length === 0) return { items: [] };
  let response: Response;
  try {
    response = await input.fetch(
      `${input.apiUrl.replace(/\/+$/, "")}/api/v1/trajectories?ids=${input.ids.map(encodeURIComponent).join(",")}`,
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.apiKey}`,
        },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "recorder-summaries-failed",
        reason: "request",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return { unavailable: "unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    console.error(
      JSON.stringify({
        type: "recorder-summaries-failed",
        reason: "status",
        status: response.status,
      }),
    );
    const final =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 429;
    return { unavailable: final ? "unavailable" : "unreachable" };
  }
  const body: unknown = await response.json().catch(() => null);
  const items =
    typeof body === "object" && body !== null && "items" in body
      ? body.items
      : null;
  if (!Array.isArray(items)) {
    console.error(
      JSON.stringify({
        type: "recorder-summaries-failed",
        reason: "not-a-list",
        status: response.status,
      }),
    );
    return { unavailable: "unreachable" };
  }
  const valid = items.filter(isTrajectorySummary);
  if (valid.length < items.length) {
    console.error(
      JSON.stringify({
        type: "recorder-summaries-dropped",
        dropped: items.length - valid.length,
      }),
    );
  }
  return { items: valid };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || isString(value);

function isTrajectorySummary(item: unknown): item is TrajectorySummary {
  if (typeof item !== "object" || item === null) return false;
  const row = item as Record<string, unknown>;
  const outcome = row.outcome;
  const outcomeOk =
    outcome === null ||
    (typeof outcome === "object" &&
      (outcome as Record<string, unknown>).phase !== undefined &&
      ["started", "succeeded", "failed"].includes(
        (outcome as Record<string, unknown>).phase as string,
      ) &&
      isStringOrNull((outcome as Record<string, unknown>).reason ?? null));
  return (
    isString(row.trajectoryId) &&
    isString(row.createdAt) &&
    isStringOrNull(row.firstEventAt) &&
    isStringOrNull(row.lastEventAt) &&
    typeof row.eventCount === "number" &&
    isStringOrNull(row.workflow) &&
    outcomeOk
  );
}

/** Intelligence takes 1 to 100 ids in one request. */
const SUMMARY_BATCH = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long after its last event a recording that has not ended still counts as being sent. */
const SENDING_WINDOW_MS = 10 * 60_000;

/**
 * How one recording ended, from its binding and what Intelligence says of it.
 *
 * A recording the person discarded or restarted is not one they made, so it has no row.
 */
export function toRow(
  binding: { trajectoryId: string; createdAt: Date },
  summary: TrajectorySummary | undefined,
  now: Date,
): RecordingRow | null {
  const id = binding.trajectoryId;
  if (!summary) {
    // Bound a moment ago, Intelligence may not have its first event yet.
    const fresh =
      now.getTime() - binding.createdAt.getTime() <= SENDING_WINDOW_MS;
    return {
      id,
      title: null,
      recordedAt: binding.createdAt.toISOString(),
      ended: fresh ? "sending" : "missing",
      reason: null,
    };
  }
  const { outcome } = summary;
  if (
    outcome?.phase === "failed" &&
    (outcome.reason === "discarded" || outcome.reason === "restarted")
  )
    return null;
  const recordedAt = summary.firstEventAt ?? binding.createdAt.toISOString();
  const row = { id, title: summary.workflow, recordedAt };
  if (outcome?.phase === "failed")
    return { ...row, ended: "stopped", reason: outcome.reason };
  if (outcome?.phase === "succeeded")
    return { ...row, ended: "succeeded", reason: null };
  const lastSeen = new Date(summary.lastEventAt ?? binding.createdAt);
  const recent = now.getTime() - lastSeen.getTime() <= SENDING_WINDOW_MS;
  return { ...row, ended: recent ? "sending" : "unknown", reason: null };
}

/**
 * A person's recordings: their page of bindings, each joined to what Intelligence says of it.
 * `isBoundTo` is declared here so the wiring passes it to the routes that check ownership.
 */
export function createRecordings(deps: {
  pageForUser: (
    userId: string,
    cursor: string | null,
    limit?: number,
  ) => Promise<{
    ids: { trajectoryId: string; createdAt: Date }[];
    nextCursor: string | null;
  }>;
  isBoundTo: (trajectoryId: string, userId: string) => Promise<boolean>;
  /** Which of these ids are this person's, in one query. Without it each id is checked on its own. */
  boundTo?: (userId: string, ids: string[]) => Promise<Set<string>>;
  summaries: (ids: string[]) => ReturnType<typeof fetchTrajectorySummaries>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    async list(userId: string, cursor: string | null): Promise<RecordingsPage> {
      const { ids, nextCursor } = await deps.pageForUser(userId, cursor, 50);
      if (ids.length === 0) return { recordings: [], nextCursor };
      const result = await deps.summaries(ids.map((id) => id.trajectoryId));
      if ("unavailable" in result)
        return {
          recordings: [],
          // A later page keeps its cursor so Show more retries it; the first page has nothing to retry from.
          nextCursor: cursor,
          unavailable: result.unavailable,
        };
      const byId = new Map(
        result.items.map((item) => [item.trajectoryId, item]),
      );
      const at = now();
      const recordings = ids
        .flatMap((binding) => {
          const row = toRow(binding, byId.get(binding.trajectoryId), at);
          return row ? [row] : [];
        })
        /*
         * By when each was made. The page is cut by when OpenBot first heard of each recording (its binding), which for
         * one the Recorder held and sent later is minutes after it was made, so a page of bindings is not in that order.
         * The sort is stable: rows made at the same moment keep the page's own order.
         */
        .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
      return { recordings, nextCursor };
    },

    /**
     * The titles of recordings a person made, by id. Ids that are not theirs are dropped before
     * Intelligence is asked, so nobody else's recording is read. An owned id maps to its title, or
     * to null when Intelligence has none or cannot be reached.
     */
    async recordingTitles(
      userId: string,
      ids: string[],
    ): Promise<Map<string, string | null>> {
      const candidates = [...new Set(ids)].filter((id) => UUID.test(id));
      const boundIds = deps.boundTo
        ? await deps.boundTo(userId, candidates)
        : new Set(
            (
              await Promise.all(
                candidates.map(async (id) =>
                  (await deps.isBoundTo(id, userId)) ? id : null,
                ),
              )
            ).filter((id) => id !== null),
          );
      const owned = candidates.filter((id) => boundIds.has(id));
      const titles = new Map<string, string | null>();
      const byId = new Map<string, TrajectorySummary>();
      for (let at = 0; at < owned.length; at += SUMMARY_BATCH) {
        const result = await deps.summaries(
          owned.slice(at, at + SUMMARY_BATCH),
        );
        if ("items" in result)
          for (const item of result.items) byId.set(item.trajectoryId, item);
      }
      for (const id of owned) titles.set(id, byId.get(id)?.workflow ?? null);
      return titles;
    },
  };
}
