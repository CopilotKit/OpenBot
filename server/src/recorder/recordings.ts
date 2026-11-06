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
