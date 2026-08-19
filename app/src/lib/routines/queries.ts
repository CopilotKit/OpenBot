import { queryOptions } from "@tanstack/react-query";

/**
 * Routines and webhook triggers, as the browser sees them.
 *
 * The shapes mirror the server's records rather than being a convenience view of them, so a field
 * added there shows up here as a type error rather than as a value the page silently ignores.
 */

export type RoutineSchedule =
  | { type: "once"; at: string }
  /** `time` is HH:MM UTC and `weekdays` is 0 for Sunday through 6 for Saturday, as the server's is. */
  | { type: "daily"; time: string; weekdays: number[] };

export type RoutineRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  /** The deployment was not running when the window came round. See the page for why this exists. */
  | "missed";

export type RoutineRun = {
  id: string;
  routineId: string;
  trigger: "schedule" | "manual" | "webhook";
  status: RoutineRunStatus;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  error: string | null;
  threadId: string | null;
};

export type Routine = {
  id: string;
  agentId: string;
  ownerUserId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Computed by the server on every read. Null for a schedule that will never call again. */
  nextDueAt: string | null;
  lastRun: RoutineRun | null;
};

export type WebhookTrigger = {
  id: string;
  /** The public path segment. The full URL is built from it where it is shown. */
  endpointId: string;
  name: string;
  routineId: string | null;
  agentId: string | null;
  prompt: string | null;
  enabled: boolean;
  /** True until somebody has looked at a real delivery and confirmed it. */
  verificationPending: boolean;
  verifiedAt: string | null;
  /** The first authenticated delivery, so the confirmation is an informed one. */
  sample: Record<string, unknown> | null;
  eventTypes: string[];
  deliveryCount: number;
  lastReceivedAt: string | null;
  createdAt: string;
};

export const routineKeys = {
  all: ["routines"] as const,
  list: () => ["routines", "list"] as const,
  runs: (routineId: string) => ["routines", "runs", routineId] as const,
  triggers: () => ["routines", "triggers"] as const,
};

export function routineListQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.list(),
    /*
     * Refetched while the page is open, because a routine's state changes without anybody on this
     * screen doing anything: the clock fires, a run finishes, a delivery arrives. A page that only
     * updated when you pressed something would show a run as still going for as long as you looked
     * at it.
     */
    refetchInterval: 15_000,
    queryFn: async (): Promise<Routine[]> => {
      const response = await fetch("/api/routines", { credentials: "include" });
      if (!response.ok) throw new Error("Routines could not be loaded.");
      return ((await response.json()) as { routines: Routine[] }).routines;
    },
  });
}

export function routineRunsQueryOptions(routineId: string) {
  return queryOptions({
    queryKey: routineKeys.runs(routineId),
    enabled: routineId.length > 0,
    refetchInterval: 15_000,
    queryFn: async (): Promise<RoutineRun[]> => {
      const response = await fetch(
        `/api/routines/${encodeURIComponent(routineId)}/runs`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error("The run history could not be loaded.");
      return ((await response.json()) as { runs: RoutineRun[] }).runs;
    },
  });
}

/**
 * Every trigger in the deployment, which is what the administrators' page shows.
 *
 * Not this person's own, unlike the routines above. A trigger is a URL somebody outside can call,
 * so the useful list is all of them; the server refuses this to anybody who is not an administrator.
 */
export function webhookTriggerQueryOptions() {
  return queryOptions({
    queryKey: routineKeys.triggers(),
    queryFn: async (): Promise<WebhookTrigger[]> => {
      const response = await fetch("/api/routines/triggers", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Triggers could not be loaded.");
      return ((await response.json()) as { triggers: WebhookTrigger[] })
        .triggers;
    },
  });
}

/**
 * Call the routines API and surface the server's own sentence when it refuses.
 *
 * The server refuses for reasons this page cannot check, and its wording is the only useful part of
 * a failure. Paraphrasing it into "That did not work" throws away the sentence somebody needs.
 */
export async function callRoutines(
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetch(`/api/routines${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    detail?: string;
  } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? body?.detail ?? "That did not work.");
  }
  return body;
}

/**
 * How a schedule reads on screen.
 *
 * The same words as routines/schedule.ts on the server, written twice because the two sides share no
 * module and the browser cannot import from the server's. Nothing enforces the agreement, so the
 * cheap thing that can be done is done: the same normalisation, through `Date`, rather than a string
 * slice that quietly disagrees the moment a schedule arrives spelled `+00:00` instead of `Z`.
 */
export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.type === "once") {
    return `Once, at ${new Date(schedule.at).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
  if (schedule.weekdays.length === 0) return "Never, no days are selected";
  if (schedule.weekdays.length === 7)
    return `Every day at ${schedule.time} UTC`;
  return `${schedule.weekdays
    .map((day) => DAY_NAMES[day] ?? String(day))
    .join(", ")} at ${schedule.time} UTC`;
}

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Weekdays, as the button row offers them: Monday first, which is how people read a week. */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
