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
 * 404 and 403 mean this Intelligence has no such route or does not let the key read it, so
 * recordings are `unavailable`. Nothing answering, a 5xx, or any other answer that is not a list is
 * `unreachable`, which may pass in a moment.
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
  } catch {
    return { unavailable: "unreachable" };
  }
  if (response.status === 404 || response.status === 403)
    return { unavailable: "unavailable" };
  if (!response.ok) return { unavailable: "unreachable" };
  const body: unknown = await response.json().catch(() => null);
  const items =
    typeof body === "object" && body !== null && "items" in body
      ? body.items
      : null;
  if (!Array.isArray(items)) return { unavailable: "unreachable" };
  return { items: items as TrajectorySummary[] };
}

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
    return {
      id,
      title: null,
      recordedAt: binding.createdAt.toISOString(),
      ended: "missing",
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
      const recordings = ids.flatMap((binding) => {
        const row = toRow(binding, byId.get(binding.trajectoryId), at);
        return row ? [row] : [];
      });
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
      const owned: string[] = [];
      for (const id of new Set(ids)) {
        if (UUID.test(id) && (await deps.isBoundTo(id, userId))) owned.push(id);
      }
      const titles = new Map<string, string | null>();
      if (owned.length === 0) return titles;
      const result = await deps.summaries(owned);
      const byId =
        "items" in result
          ? new Map(result.items.map((item) => [item.trajectoryId, item]))
          : new Map<string, TrajectorySummary>();
      for (const id of owned) titles.set(id, byId.get(id)?.workflow ?? null);
      return titles;
    },
  };
}
