import { queryOptions } from "@tanstack/react-query";
import type { Routine, RoutineRun } from "@/lib/api/generated/model";
import {
  listRoutineRuns,
  listRoutines,
} from "@/lib/api/generated/routines/routines";
import { ORGANIZATION_ID } from "@/lib/api/request";

/**
 * One standing instruction, as the Routines page sees it: the API's `Routine`, generated from the
 * spec.
 *
 * `schedule` IS OPAQUE DISPLAY TEXT, NEVER A VALUE TO PARSE. The server computes it once, from the
 * same library that decides when the routine actually fires — prose for a shape it recognizes, the
 * raw five-field cron expression for anything stranger than that. Rendering it verbatim is the only
 * correct thing to do with it; a second cron-to-English implementation in the browser would drift
 * out of step with the server's the first time either one changes.
 *
 * `botId` is the Bot that carries it out, so a Bot's own dialog can show only its routines.
 * `conversation` is where it posts: name it by its `title`, the conversation as the sidebar titles
 * it, since `name` is only its Bots' names, so every conversation with General Assistant is called
 * "General Assistant". `lastRun` null means no run has ever finished; a `status` of null means a
 * run is open — started but not yet finished, whether genuinely in flight or stuck there after
 * repeated dispatch failures. Neither is a failure; only `status: "failed"` is. `goalId` is the
 * goal it runs, or null: the server resolves it, older routines included, so the Routines list
 * draws such a routine as a start of that goal's row (`lib/routines/merged.ts`).
 */
export type RoutineRecord = Routine;

/** What the routines screens read: every one of the person's routines. */
export type RoutinesPage = { routines: RoutineRecord[] };

/**
 * How often routines and goals are read again while a screen shows them. A Routines row and a goal's
 * page are built from both reads, and either changes without this screen: a run completes a goal and
 * the server switches its schedule off, or a Bot gives a goal a schedule. Both reads use this one
 * interval, so neither stays stale longer than the other.
 */
export const ROUTINES_REFETCH_MS = 10_000;

export const routineKeys = {
  all: ["routines"] as const,
  list: () => ["routines", "list"] as const,
  runs: (id: string) => ["routines", id, "runs"] as const,
};

/** One firing of a routine, scheduled or Run now: the API's `RoutineRun`. */
export type RoutineRunRecord = RoutineRun;

/**
 * Every item of a list, page by page.
 *
 * The API pages every list (`cursor`, `limit`, `nextCursor`), and the screens here want the whole
 * list, so this reads to the end. A server that hands back the cursor it was given is a server that
 * would never end the list, so a repeated cursor ends it too.
 */
export async function everyPage<T>(
  read: (params: {
    limit: number;
    cursor?: string;
  }) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read({ limit: 100, ...(cursor ? { cursor } : {}) });
    all.push(...page.items);
    if (cursor) seen.add(cursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && !seen.has(cursor));
  return all;
}

export function routineRunsQueryOptions(id: string) {
  return queryOptions({
    queryKey: routineKeys.runs(id),
    queryFn: ({ signal }): Promise<RoutineRunRecord[]> =>
      everyPage(async (params) => {
        const page = await listRoutineRuns(ORGANIZATION_ID, id, params, {
          signal,
          fallback: "This routine's runs could not be loaded.",
        });
        return { items: page.runs, nextCursor: page.nextCursor };
      }),
    // A run in flight settles within minutes; poll so Running turns into its outcome.
    refetchInterval: 5_000,
  });
}

/**
 * The signed-in person's own routines, newest first.
 *
 * Owner-scoped by the server on every read; there is no version of this that takes an owner id,
 * the same way `connectionsQueryOptions` answers only for whoever is asking.
 */
export function routinesQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.list(),
    queryFn: async ({ signal }): Promise<RoutinesPage> => ({
      routines: await everyPage(async (params) => {
        const page = await listRoutines(ORGANIZATION_ID, params, {
          signal,
          fallback: "Your routines could not be loaded.",
        });
        return { items: page.routines, nextCursor: page.nextCursor };
      }),
    }),
    refetchInterval: ROUTINES_REFETCH_MS,
  });
}
