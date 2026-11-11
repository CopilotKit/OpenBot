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
  /** Which Bot carries it out, so a Bot's own dialog can show only its routines. */
  agentId: string;
  schedule: string;
  timezone: string;
  instruction: string;
  /** What the person called it, or null when they named it nothing: then its schedule heads the row. */
  title: string | null;
  /**
   * Where it posts. Name it by `title`, the conversation as the sidebar titles it: `name` is only its
   * Bots' names, so every conversation with General Assistant is called "General Assistant".
   */
  channel: {
    id: string;
    name: string | null;
    title: string | null;
    gone: boolean;
  };
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
  /**
   * The goal it runs, or null. The server resolves it, older routines included, so the Routines
   * list draws such a routine as a start of that goal's row (`lib/routines/merged.ts`). Absent from
   * a server that predates it, which reads as running none.
   */
  goalId?: string | null;
};

export type SweepRecord = {
  lastSweptAt: string | null;
  working: boolean;
};

export type RoutinesPage = {
  routines: RoutineRecord[];
  sweep: SweepRecord;
};

export function nothingIsFiring(
  sweep: SweepRecord | undefined,
  routineCount: number,
): boolean {
  return sweep !== undefined && !sweep.working && routineCount > 0;
}

/**
 * What the Routines page says when nothing is running them, for whoever reads it.
 *
 * A team member's admin runs OpenBot, so they are pointed at one. The personal edition has no
 * admin: the person reading is the one who runs it, and restarting OpenBot restarts what runs
 * routines (OpenBot Desktop and `scripts/start.sh` both start it with the server). There is no
 * restart to press here, so it says what to do. Before the edition is known it says only what is
 * true for both, so a personal owner is never told to ask an admin for a moment.
 *
 * `lastSwept` is the last check already put into words (`relativeTime`), or null when none was
 * ever recorded. A stop is never described as routines that ran.
 */
export function stoppedRoutinesGuidance(
  lastSwept: string | null,
  edition: "team" | "personal" | undefined,
): string {
  const fact = lastSwept
    ? `OpenBot last checked them ${lastSwept}. None will run until it starts again.`
    : "OpenBot hasn't started running routines yet, so none of these will run.";
  if (edition === "personal") return `${fact} Restart OpenBot to start them.`;
  if (edition === "team")
    return lastSwept
      ? `${fact} Ask an admin if this keeps happening.`
      : `${fact} Ask an admin to set this up.`;
  return fact;
}

export const routineKeys = {
  all: ["routines"] as const,
  list: () => ["routines", "list"] as const,
  runs: (id: string) => ["routines", id, "runs"] as const,
};

/** One firing of a routine, scheduled or Run now. */
export type RoutineRunRecord = {
  id: string;
  status: "running" | "succeeded" | "failed" | "skipped" | "waiting";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** What started it: the schedule, a person's Run now, or an event trigger. */
  source: "schedule" | "run_now" | "trigger";
};

export function routineRunsQueryOptions(id: string) {
  return queryOptions({
    queryKey: routineKeys.runs(id),
    queryFn: (): Promise<RoutineRunRecord[]> =>
      client(`/api/routines/${encodeURIComponent(id)}/runs`, "runs", {
        fallback: "This routine's runs could not be loaded.",
      }),
    // A run in flight settles within minutes; poll so Running turns into its outcome.
    refetchInterval: 5_000,
  });
}

/**
 * The signed-in person's own routines.
 *
 * Owner-scoped by the server on every read; there is no version of this that takes an owner id,
 * the same way `connectionsQueryOptions` answers only for whoever is asking.
 */
export function routinesQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.list(),
    queryFn: async (): Promise<RoutinesPage> => {
      const response = await client("/api/routines", {
        fallback: "Your routines could not be loaded.",
      });
      const body = (await response.json()) as Partial<RoutinesPage>;
      return {
        routines: body.routines ?? [],
        sweep: body.sweep ?? { lastSweptAt: null, working: false },
      };
    },
  });
}
