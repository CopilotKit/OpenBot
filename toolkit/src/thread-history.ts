/**
 * Whether this failure means "the platform has never heard of that thread".
 *
 * A thread id is minted before the thread exists — the platform creates it on the first run — so
 * reading history on a brand-new conversation is the normal opening move, and the platform answers
 * `THREAD_NOT_FOUND` with a 404. The runtime's own handler catches everything and returns a bare 500,
 * so every new chat produced one, with a stack trace behind it.
 *
 * Matched on the shape rather than with `instanceof`. The class is `PlatformRequestError` and it
 * carries `.status` for exactly this — its own documentation gives `error.status === 404` as the
 * example — but it is not re-exported from `@copilotkit/runtime/v2`, and the package's `exports` map
 * offers no subpath that reaches it, so there is no type to test against. The name is set by the
 * constructor and the status is a number on the instance; both are checked, so an unrelated error
 * carrying a `status` of 404 does not qualify.
 *
 * 404 ONLY, and nothing wider. A 500 from the platform means an outage or a bad key, and answering
 * that with an empty history would tell the browser the conversation is gone and invite somebody to
 * start it over. That is the failure this must not introduce while removing the noisy one.
 */
export function isMissingThread(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "PlatformRequestError" &&
    (error as { status?: unknown }).status === 404
  );
}

/**
 * Read a thread's history, treating a thread the platform does not know about as having none.
 *
 * Takes the read as a function rather than being folded into `IntelligenceKnowingANewThread` in
 * copilot.ts, so the decision can be exercised against a function that really throws. The previous
 * attempt at this fix (#71) was tested by re-implementing its middleware inside the test file, which
 * passes with the real code deleted; this is the actual code path in both places.
 */
export async function historyOrEmpty<T>(
  read: () => Promise<T>,
  whenMissing: T,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isMissingThread(error)) return whenMissing;
    throw error;
  }
}
