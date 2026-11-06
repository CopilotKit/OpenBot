import type { RecordingRow } from "@openbot/shared/recorder-api";

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
