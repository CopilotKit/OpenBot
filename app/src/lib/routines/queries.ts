import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * One standing instruction, as the Routines page sees it.
 *
 * `schedule` IS OPAQUE DISPLAY TEXT, NEVER A VALUE TO PARSE. The server computes it once, from the
 * same library that decides when the routine actually fires — prose for a shape it recognizes, the
 * raw five-field cron expression for anything stranger than that. Rendering it verbatim is the only
 * correct thing to do with it; a second cron-to-English implementation in the browser would drift
 * out of step with the server's the first time either one changes.
 */
export type RoutineRecord = {
  id: string;
  schedule: string;
  timezone: string;
  instruction: string;
  channel: { id: string; name: string | null; gone: boolean };
  enabled: boolean;
  nextRunAt: string;
  /**
   * Null means no run has ever finished. An object with `status: null` means a run is open —
   * started but not yet finished, whether genuinely in flight or stuck there after repeated
   * dispatch failures. Neither is a failure; only `status: "failed"` is.
   */
  lastRun: {
    status: "succeeded" | "failed" | "skipped" | null;
    at: string | null;
  } | null;
};

export const routineKeys = {
  all: ["routines"] as const,
  list: () => ["routines", "list"] as const,
};

/**
 * The signed-in person's own routines.
 *
 * Owner-scoped by the server on every read; there is no version of this that takes an owner id,
 * the same way `connectionsQueryOptions` answers only for whoever is asking.
 */
export function routinesQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.list(),
    queryFn: (): Promise<RoutineRecord[]> =>
      client("/api/routines", "routines", {
        fallback: "Your routines could not be loaded.",
      }),
  });
}
