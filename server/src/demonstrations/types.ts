import { z } from "zod";

const target = z
  .object({
    role: z.string().min(1).max(40),
    name: z.string().min(1).max(120),
    sensitive: z.boolean(),
  })
  .strict();
export const demonstrationActionSchema = z
  .object({
    kind: z.enum(["click", "type", "key", "scroll"]),
    url: z
      .string()
      .max(2000)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["http:", "https:", "about:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }),
    target,
    key: z
      .enum([
        "Enter",
        "Tab",
        "Escape",
        "Backspace",
        "Delete",
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageDown",
        "PageUp",
      ])
      .optional(),
    deltaY: z.number().min(-2000).max(2000).optional(),
  })
  .strict();
export type DemonstrationAction = z.infer<typeof demonstrationActionSchema>;
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
