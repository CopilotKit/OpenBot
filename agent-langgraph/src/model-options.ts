/**
 * Model settings a deployment can turn, checked before the Bot starts.
 *
 * Its own module for the reason `history.ts` is: `index.ts` calls `serve()` at module scope, so
 * importing it to reach one pure function binds a port.
 */

/**
 * The efforts the installed OpenAI API knows, in the order it documents them.
 *
 * Kept as a list rather than described in prose because it is also the error message: an operator
 * who guessed wrong should be told what to write instead, not sent to find the API reference.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** An effort to ask for, or what is wrong with the one that was configured. */
export interface ReasoningEffortSetting {
  effort?: ReasoningEffort;
  problem?: string;
}

/**
 * How hard this Bot should think, from the environment.
 *
 * Unset means unset: no `reasoning` is sent and the model keeps whatever default its provider
 * chose. An empty string is the same thing, because a compose file passing
 * `BOT_REASONING_EFFORT: ${BOT_REASONING_EFFORT:-}` hands this one — the same trap `BOT_MODEL`
 * already documents.
 *
 * A value the API does not have is a problem rather than a silently dropped setting. That is the
 * whole complaint: configuration that goes nowhere leaves a Bot that starts, looks healthy, and
 * thinks for as long as it likes.
 */
export function readReasoningEffort(
  raw: string | undefined,
): ReasoningEffortSetting {
  const value = raw?.trim().toLowerCase();
  if (!value) return { effort: undefined };

  if ((REASONING_EFFORTS as readonly string[]).includes(value)) {
    return { effort: value as ReasoningEffort };
  }

  return {
    problem:
      `BOT_REASONING_EFFORT=${raw?.trim()} is not an effort this API has. ` +
      `Use one of: ${REASONING_EFFORTS.join(", ")}.`,
  };
}
