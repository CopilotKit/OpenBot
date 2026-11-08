import type { HeadlessWaiting } from "@openbot/toolkit/headless-tools";
import { z } from "zod";

export const responsibilitySources = [
  "manual",
  "slack",
  "github",
  "schedule",
  "connector",
  "webhook",
  "linear",
  "sentry",
  "pagerduty",
  "email",
] as const;
export type ResponsibilitySource = (typeof responsibilitySources)[number];
export type ResponsibilityStatus = "active" | "paused" | "completed";
export type ResponsibilityRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped";

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
export const subscriptionSchema = z.object({
  source: z.enum(responsibilitySources),
  eventType: text(128),
});
/** What a person or a Bot says about a goal, without the defaults a new one takes. */
const goalFields = {
  title: text(160),
  instruction: text(6000),
  successCriteria: text(3000),
  subscriptions: z.array(subscriptionSchema).max(20),
  /**
   * Done again and again, every morning or each time something happens, and never finished by one
   * run. A goal a routine runs or an event wakes repeats without it (`GoalRepeats`).
   */
  recurring: z.boolean(),
};
export const responsibilityInputSchema = z
  .object({
    agentId: text(128),
    channelId: text(128),
    ...goalFields,
    subscriptions: goalFields.subscriptions.default([]),
    recurring: goalFields.recurring.default(false),
  })
  .strict();
/**
 * Only what changes. Built from the fields without their defaults: picked from the input schema, a
 * patch of a title alone also set `subscriptions` to [] and would set `recurring` to false.
 */
export const responsibilityPatchSchema = z
  .object(goalFields)
  .partial()
  .strict();
export const responsibilityEventSchema = z
  .object({
    ownerUserId: text(128),
    source: z.enum(responsibilitySources),
    externalId: text(256),
    type: text(128),
    payload: z.record(z.string(), z.unknown()).default({}),
    responsibilityId: text(128).optional(),
    /**
     * The registered trigger that authenticated this delivery. Server-set by an ingress route after
     * it verified the sender; it targets exactly `responsibilityId`, whose subscriptions are then not
     * consulted because the trigger's own filter already matched.
     */
    triggerId: text(128).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (JSON.stringify(event.payload).length > 32_768)
      context.addIssue({
        code: "custom",
        message: "Event payload exceeds 32 KiB.",
      });
    if (event.triggerId && !event.responsibilityId)
      context.addIssue({
        code: "custom",
        message: "A trigger event must name its goal.",
      });
  });

export class ResponsibilityNotFoundError extends Error {
  constructor() {
    super("This goal could not be found.");
    this.name = "ResponsibilityNotFoundError";
  }
}
export class ResponsibilityRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsibilityRefusedError";
  }
}
export type ResponsibilityInput = z.infer<typeof responsibilityInputSchema>;
export type ResponsibilityPatch = z.infer<typeof responsibilityPatchSchema>;
export type ResponsibilityEvent = z.infer<typeof responsibilityEventSchema>;
export type ResponsibilitySubscription = z.infer<typeof subscriptionSchema>;
export function parseResponsibilityInput(input: unknown): ResponsibilityInput {
  const result = responsibilityInputSchema.safeParse(input);
  if (!result.success)
    throw new ResponsibilityRefusedError(
      result.error.issues[0]?.message ?? "Invalid goal.",
    );
  return result.data;
}
export function parseResponsibilityPatch(input: unknown): ResponsibilityPatch {
  const result = responsibilityPatchSchema.safeParse(input);
  if (!result.success || Object.keys(result.data).length === 0)
    throw new ResponsibilityRefusedError(
      "Supply a title, instruction, success criteria or event subscriptions.",
    );
  return result.data;
}
export function parseResponsibilityEvent(input: unknown): ResponsibilityEvent {
  const result = responsibilityEventSchema.safeParse(input);
  if (!result.success)
    throw new ResponsibilityRefusedError(
      result.error.issues[0]?.message ?? "Invalid event.",
    );
  return result.data;
}
export type Responsibility = ResponsibilityInput & {
  id: string;
  ownerUserId: string;
  threadId: string;
  status: ResponsibilityStatus;
  progress: string;
  lastResult: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};
export type ResponsibilityContinuation = {
  waiting: HeadlessWaiting;
  response: unknown;
};
/**
 * Why a goal runs again and again, so that no run of it is the last: it was made `recurring`, an
 * enabled routine of its Bot names it, or an event wakes it (a subscription or an enabled trigger).
 *
 * FOUND ON WINDOWS: asked to "check the latest OpenBot release every morning and tell me what
 * changed, and run it now", a Bot made a goal and a daily routine that runs it. The goal's first run
 * met its success criteria, as every run of it would, and completed the goal. The next morning's
 * routine would have found nothing to run. A goal that repeats is ended by the person, never by one
 * of its runs.
 */
export type GoalRepeats = "recurring" | "routine" | "event";

/** The quotes a Bot puts round a goal's title when it names one: straight, curly, angled, backticks. */
const TITLE_QUOTES = [
  ['"', '"'],
  ["\u201c", "\u201d"],
  ["'", "'"],
  ["\u2018", "\u2019"],
  ["\u00ab", "\u00bb"],
  ["`", "`"],
] as const;

/** The routine fields that say which goal it runs. */
export type RoutineGoalLink = {
  /** The goal it was made for, or whose `run_goal` its firing called. */
  goalId: string | null;
  /** Made before routines recorded their goal: read its instruction instead. */
  goalByTitle: boolean;
  instruction: string;
};

/**
 * Whether this routine runs this goal. One rule, read by the goal store (`GoalRepeats`), by a Bot's
 * Activity, and by the routine store when it names an untitled routine for its goal.
 *
 * BY THE GOAL IT RECORDS. A routine made for a goal records its id, and runs that goal and no other.
 *
 * FOUND BEFORE 0.3.3: the rule was "the instruction contains the goal's title anywhere", so a goal
 * titled "Email" was run by any routine that mentioned email. Its runs could then never complete it,
 * and Activity listed it with somebody else's schedule. A routine made before routines recorded their
 * goal (`goalByTitle`) is still read from its instruction, but only by the goal's id or its whole
 * title, exactly, between quotes: `Run the goal "Track OpenBot releases"`, never a word inside a
 * sentence.
 */
export function routineRunsGoal(
  routine: RoutineGoalLink,
  goal: { id: string; title: string },
): boolean {
  if (routine.goalId) return routine.goalId === goal.id;
  if (!routine.goalByTitle) return false;
  return (
    routine.instruction.includes(goal.id) ||
    TITLE_QUOTES.some(([open, close]) =>
      routine.instruction.includes(`${open}${goal.title}${close}`),
    )
  );
}

/** The reason, for a sentence the model reads: "This goal repeats because ...". */
export function whyItRepeats(repeats: GoalRepeats): string {
  switch (repeats) {
    case "recurring":
      return "it was set up to repeat";
    case "routine":
      return "a routine runs it";
    case "event":
      return "an event wakes it";
  }
}

export type ResponsibilityRunContext = {
  runId: string;
  responsibilityId: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  instruction: string;
  successCriteria: string;
  progress: string;
  eventId: string;
  event: {
    source: ResponsibilitySource;
    type: string;
    payload: Record<string, unknown>;
  };
  continuation: ResponsibilityContinuation | null;
  /** Why this goal runs again, or null when this run may complete it. Absent is null. */
  repeats?: GoalRepeats | null;
};
export type ResponsibilityRunOutcome =
  | { status: "succeeded"; replyText: string }
  | { status: "waiting"; waiting: HeadlessWaiting; error: string }
  | { status: "failed" | "skipped"; error: string };
export type ResponsibilityRun = {
  id: string;
  responsibilityId: string;
  eventId: string;
  status: ResponsibilityRunStatus;
  replyText: string | null;
  error: string | null;
  waiting: HeadlessWaiting | null;
  continuation: ResponsibilityContinuation | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
export type ResponsibilityEventResult = {
  eventId: string;
  duplicate: boolean;
  runIds: string[];
};
export type ResponsibilityStore = {
  create(ownerUserId: string, input: unknown): Promise<Responsibility>;
  list(ownerUserId: string): Promise<Responsibility[]>;
  get(ownerUserId: string, id: string): Promise<Responsibility>;
  update(
    ownerUserId: string,
    id: string,
    patch: unknown,
  ): Promise<Responsibility>;
  transition(
    ownerUserId: string,
    id: string,
    status: ResponsibilityStatus,
  ): Promise<Responsibility>;
  recordProgress(
    ownerUserId: string,
    id: string,
    input: { summary: string; sourceRunId?: string; complete?: boolean },
    agentId?: string,
  ): Promise<Responsibility>;
  /** Why this goal runs again and again, or null when its runs may complete it. */
  repeats(ownerUserId: string, id: string): Promise<GoalRepeats | null>;
  listRuns(ownerUserId: string, id: string): Promise<ResponsibilityRun[]>;
  ingestEvent(input: unknown): Promise<ResponsibilityEventResult>;
  beginRun(
    runId: string,
    options?: { recovered: boolean },
  ): Promise<ResponsibilityRunContext | null>;
  settleRun(runId: string, outcome: ResponsibilityRunOutcome): Promise<void>;
  /**
   * Put a run that started back in the queue, unrun: its conversation was busy, so nothing happened.
   * False when it is no longer running.
   */
  requeueRun(runId: string): Promise<boolean>;
  resumeWaiting(
    ownerUserId: string,
    runId: string,
    response: unknown,
  ): Promise<boolean>;
};
