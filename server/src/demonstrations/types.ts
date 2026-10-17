import {
  type DemonstrationAction,
  demonstrationActionSchema,
} from "@openbot/shared/demonstration-schema";

export type { DemonstrationAction };
export { demonstrationActionSchema };
/** A demonstration records at most ten minutes; the server stops it at this bound. */
export const DEMONSTRATION_MAX_DURATION_MS = 10 * 60 * 1000;
/** When a recording started at `createdAt` is stopped by the server. */
export function demonstrationExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + DEMONSTRATION_MAX_DURATION_MS);
}
/** Whether a finished recording ran until the server's time limit stopped it. */
export function reachedDemonstrationTimeLimit(row: {
  createdAt: Date;
  finishedAt: Date | null;
}): boolean {
  return (
    row.finishedAt !== null &&
    row.finishedAt.getTime() - row.createdAt.getTime() >=
      DEMONSTRATION_MAX_DURATION_MS
  );
}
export type DemonstrationDraft = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  tools: string[];
  requiredTools: string[];
  sourceRecordingId: string;
};
/** Where a recording is made: the Bot's own browser, or the person's browser through the Recorder extension. */
export type DemonstrationSource = "computer" | "extension";
/** A batch of steps began beyond the steps the server holds; `count` is how many it holds. */
export class DemonstrationGapError extends Error {
  constructor(readonly count: number) {
    super("Steps arrived out of order.");
    this.name = "DemonstrationGapError";
  }
}
/** The person already has an open extension recording for this Bot. */
export class DemonstrationOpenError extends Error {
  constructor(readonly demonstrationId: string) {
    super("You already have an open recording for this Bot.");
    this.name = "DemonstrationOpenError";
  }
}
export class DemonstrationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemonstrationRefusedError";
  }
}
export class DemonstrationNotFoundError extends Error {
  constructor() {
    super("This demonstration could not be found.");
    this.name = "DemonstrationNotFoundError";
  }
}
export function parseDemonstrationAction(input: unknown): DemonstrationAction {
  const parsed = demonstrationActionSchema.safeParse(input);
  if (!parsed.success)
    throw new DemonstrationRefusedError(
      "The recorded action was not safe to retain.",
    );
  return parsed.data;
}
