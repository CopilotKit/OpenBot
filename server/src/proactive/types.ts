import { z } from "zod";
import type { ProactiveSkipReason } from "./contracts";

export type ProactiveRunStatus = "idle" | "running" | "succeeded" | "error";
/**
 * `superseded` is OpenBot's, never the person's: a later check-in cleared this one as no longer
 * needed (`clear_next_step`). Kept apart from `dismissed` (Hide) so that list stays a record of the
 * person's own decisions, which is what later check-ins learn from.
 */
export type SuggestionStatus = "open" | "dismissed" | "started" | "superseded";

/** Bounds on how often a Bot may look through a person's apps: once an hour at most, once a day at least. */
export const MIN_INTERVAL_MINUTES = 60;
export const MAX_INTERVAL_MINUTES = 1440;
/** How often a new check-in setting runs unless the person chose otherwise: hourly. */
export const DEFAULT_INTERVAL_MINUTES = 60;
/** Per run, so one confused run cannot flood the inbox or the memory list. */
export const MAX_SUGGESTIONS_PER_RUN = 5;
export const MAX_MEMORIES_PER_RUN = 10;
/**
 * How long an item the person hid stays out of later check-ins, and how far back a check-in is told
 * what they hid and what they started. Thirty days, as Hide has always held, so nothing hidden today
 * comes back sooner than it used to.
 */
export const HIDDEN_DAYS = 30;

/**
 * An item's title as the repeat check compares it, and as `dedupe_key` stores it: case, runs of
 * spacing and trailing punctuation are not a different item. "Reply to Rosa." and "reply to  rosa"
 * are one thing to the person, so they are one thing here.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?]+$/, "")
    .trim();
}

/**
 * A source link as the repeat check compares it: the URL parser's own spelling (so a host's case is
 * not a difference) without a trailing slash on the path or the fragment, where Gmail keeps a
 * message's id. Null for no link, or one that won't parse.
 */
export function linkKey(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link.trim());
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.hash = url.hash.replace(/\/+$/, "");
    return url.href;
  } catch {
    return null;
  }
}

const focusSchema = z.string().trim().max(1000);
const intervalSchema = z
  .number()
  .int()
  .min(MIN_INTERVAL_MINUTES)
  .max(MAX_INTERVAL_MINUTES);

export const proactiveSettingInputSchema = z
  .object({
    agentId: z.string().trim().min(1).max(128),
    channelId: z.string().trim().min(1).max(128),
    focus: focusSchema.default(""),
    intervalMinutes: intervalSchema.default(DEFAULT_INTERVAL_MINUTES),
    enabled: z.boolean().default(true),
  })
  .strict();
/**
 * A change to a setting: only the fields sent, and nothing filled in for the rest.
 *
 * Built from the bare fields, never from the input schema above. Zod keeps a field's default through
 * `.partial()`, on purpose, so a patch picked from that schema filled every field it was not sent: a
 * person turning check-ins off was also put back to hourly with no focus, and one changing how often
 * had them turned back on and run at once.
 */
export const proactiveSettingPatchSchema = z
  .object({
    focus: focusSchema,
    intervalMinutes: intervalSchema,
    enabled: z.boolean(),
  })
  .partial()
  .strict();

/**
 * Why a check-in was skipped, as the person reads it on the Bot's check-ins and in Run now's answer.
 * One plain sentence each, saying what to do where there is something to do.
 */
export const SKIPPED_BECAUSE: Record<ProactiveSkipReason, string> = {
  off_admin: "Your admin turned off check-ins for you.",
  off_person: "You turned off check-ins for all your Bots.",
  paused: "You paused this Bot.",
  capped: "This Bot used all its check-ins for today.",
  unreachable: "This Bot or its conversation is no longer available to you.",
  no_sources:
    "Nothing to check: this Bot can't read anything you've connected. Connect an app with your own account.",
  busy: "Another check-in was still running.",
};

export const suggestionInputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe("What to do, in plain words the person would use."),
    detail: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe(
        "Why it matters and what you found, written for the person. Never name tools or functions.",
      ),
    sourceTool: z
      .string()
      .trim()
      .min(1, "Name the tool you read the evidence with.")
      .max(256)
      .describe(
        "The tool you read the evidence with in this check-in. Required: recorded as the source, which the person sees as the app it came from.",
      ),
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
/** `clear_next_step`: an item this Bot raised earlier that no longer needs the person. */
export const clearInputSchema = z
  .object({
    suggestionId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("The id of one of your items listed as still open."),
    why: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "Why it no longer needs them, from what you read: answered, done, cancelled.",
      ),
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
  /** The normalized title (`titleKey`), or null on items from before it was kept. */
  dedupeKey: string | null;
  /** The ping that carried it, or null while it waits for the person's hourly slot. */
  pingId: string | null;
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
