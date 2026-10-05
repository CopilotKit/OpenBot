import { z } from "zod";
import type { HeadlessWaiting } from "../computer/headless-tools";

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
export const responsibilityInputSchema = z
  .object({
    agentId: text(128),
    channelId: text(128),
    title: text(160),
    instruction: text(6000),
    successCriteria: text(3000),
    subscriptions: z.array(subscriptionSchema).max(20).default([]),
  })
  .strict();
export const responsibilityPatchSchema = responsibilityInputSchema
  .pick({
    title: true,
    instruction: true,
    successCriteria: true,
    subscriptions: true,
  })
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
        message: "A trigger event must name its responsibility.",
      });
  });

export class ResponsibilityNotFoundError extends Error {
  constructor() {
    super("This responsibility could not be found.");
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
      result.error.issues[0]?.message ?? "Invalid responsibility.",
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
  listRuns(ownerUserId: string, id: string): Promise<ResponsibilityRun[]>;
  ingestEvent(input: unknown): Promise<ResponsibilityEventResult>;
  beginRun(
    runId: string,
    options?: { recovered: boolean },
  ): Promise<ResponsibilityRunContext | null>;
  settleRun(runId: string, outcome: ResponsibilityRunOutcome): Promise<void>;
  resumeWaiting(
    ownerUserId: string,
    runId: string,
    response: unknown,
  ): Promise<boolean>;
};
