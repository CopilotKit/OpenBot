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
