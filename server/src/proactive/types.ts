import { z } from "zod";

export type ProactiveRunStatus = "idle" | "running" | "succeeded" | "error";
export type SuggestionStatus = "open" | "dismissed" | "started";

/** Bounds on how often a Bot may look through a person's apps: once an hour at most, once a day at least. */
export const MIN_INTERVAL_MINUTES = 60;
export const MAX_INTERVAL_MINUTES = 1440;
/** Per run, so one confused run cannot flood the inbox or the memory list. */
export const MAX_SUGGESTIONS_PER_RUN = 5;
export const MAX_MEMORIES_PER_RUN = 10;

export const proactiveSettingInputSchema = z
  .object({
    agentId: z.string().trim().min(1).max(128),
    channelId: z.string().trim().min(1).max(128),
    focus: z.string().trim().max(1000).default(""),
    intervalMinutes: z
      .number()
      .int()
      .min(MIN_INTERVAL_MINUTES)
      .max(MAX_INTERVAL_MINUTES)
      .default(240),
    enabled: z.boolean().default(true),
  })
  .strict();
export const proactiveSettingPatchSchema = proactiveSettingInputSchema
  .pick({ focus: true, intervalMinutes: true, enabled: true })
  .partial()
  .strict();

export const suggestionInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(2000),
    sourceTool: z.string().trim().min(1).max(256).optional(),
    sourceLink: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
        "Links must be http or https URLs.",
      )
      .optional(),
  })
  .strict();
export const proactiveMemoryInputSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    sourceTool: z.string().trim().min(1).max(256),
    sourceLink: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
        "Links must be http or https URLs.",
      )
      .optional(),
  })
  .strict();

export type ProactiveSettingInput = z.infer<typeof proactiveSettingInputSchema>;
export type ProactiveSetting = {
  id: string;
  ownerUserId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  focus: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastStatus: ProactiveRunStatus;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type ProactiveSuggestion = {
  id: string;
  ownerUserId: string;
  agentId: string;
  settingId: string;
  runId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  status: SuggestionStatus;
  deliveredAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

export class ProactiveRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProactiveRefusedError";
  }
}
export class ProactiveNotFoundError extends Error {
  constructor() {
    super("This could not be found.");
    this.name = "ProactiveNotFoundError";
  }
}

export function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ProactiveRefusedError(
      result.error.issues[0]?.message ?? "Invalid settings.",
    );
  return result.data;
}
