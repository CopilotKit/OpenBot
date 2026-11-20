/**
 * Intelligence holds one run per thread. When the UI already shows the last reply as finished, the
 * hosted lock can still be held for a short while — a follow-up then fails with 409 / "Thread … is
 * locked". That is retryable; the person should not see the raw thread id.
 */

/** What the person reads when a follow-up hits a thread that is still locked. */
export const THREAD_LOCKED =
  "The last reply is still finishing. Wait a moment and try again.";

/** How many times a just-idle send retries a locked thread before giving up. */
export const THREAD_LOCK_TRIES = 4;

/**
 * How long to wait before each retry, in ms. Short at first (the lock often clears in under a
 * second), then longer; capped so a stuck lock does not hang the send for tens of seconds.
 */
export function threadLockWaitMs(attempt: number): number {
  return Math.min(800 * (attempt + 1), 3_200);
}

/**
 * Whether a failure is Intelligence refusing a run because another run still holds the thread.
 *
 * Matches CopilotKit's `AgentThreadLockedError` (`Thread <id> is locked`), the hosted
 * `THREAD_LOCK_FAILED` body, and the same text wrapped in a REST run failure.
 */
export function isThreadLocked(reported: unknown): boolean {
  if (
    reported instanceof Error &&
    reported.name === "AgentThreadLockedError"
  ) {
    return true;
  }
  const said = textOf(reported);
  if (!said) return false;
  // After `stoppedReason` rewrites the raw lock into `THREAD_LOCKED`, retries still recognize it.
  if (said.trim() === THREAD_LOCKED) return true;
  if (/^Thread .+ is locked\.?$/i.test(said.trim())) return true;
  if (/^Thread is locked\.?$/i.test(said.trim())) return true;
  if (/THREAD_LOCK_FAILED/i.test(said)) return true;
  if (/already locked by another runner/i.test(said)) return true;
  if (/agent_thread_locked/i.test(said)) return true;
  const rest = /^REST \w+ request failed\b:?\s*/.exec(said.trim());
  if (!rest) return false;
  try {
    const body = JSON.parse(said.trim().slice(rest[0].length)) as unknown;
    return bodyLooksLocked(body);
  } catch {
    return false;
  }
}

function textOf(reported: unknown): string {
  if (reported instanceof Error) return reported.message;
  if (typeof reported === "string") return reported;
  return "";
}

function bodyLooksLocked(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : null;
  for (const part of [record, nested]) {
    if (!part) continue;
    const code = part.code ?? part.error;
    if (typeof code === "string" && /THREAD_LOCK_FAILED|agent_thread_locked/i.test(code))
      return true;
    const message = part.message ?? part.detail;
    if (typeof message === "string" && isThreadLocked(message)) return true;
  }
  return false;
}
