import type { ThreadReader } from "./thread-routes";

/**
 * Build a {@link ThreadReader} from Intelligence's own thread lookup.
 *
 * `getThread` is typed as narrowly as this file needs it — a method that takes a thread and a
 * person and either resolves or throws — rather than as the concrete `CopilotKitIntelligence`
 * client. That keeps this file from importing a vendor class just to describe one call on it, and
 * means a test can hand it a stub with no client to construct.
 *
 * The status check is duck-typed on `error?.status === 404` rather than an `instanceof` check
 * against the client's own error class, because that class is not part of `@copilotkit/runtime/v2`'s
 * public surface: importing it would mean reaching past the package's exports into its internals,
 * which is exactly the kind of dependency a version bump breaks without warning. The shape of a 404
 * is a much smaller promise for the vendor to keep than the identity of an internal class.
 *
 * Anything that is not that specific shape is rethrown unchanged, never folded into `"unknown"`. A
 * 404 is Intelligence telling this deployment, in terms it can act on, that the thread is gone; a
 * timeout, a 500, or a malformed response is Intelligence (or the network) failing to tell it
 * anything, and treating the two the same would let a browser discard history that is only
 * temporarily unreachable, not actually missing.
 */
export function createThreadReader(intelligence: {
  getThread: (params: { threadId: string; userId: string }) => Promise<unknown>;
}): ThreadReader {
  return async (threadId, userId) => {
    try {
      await intelligence.getThread({ threadId, userId });
      return "known";
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status === 404) {
        return "unknown";
      }
      throw error;
    }
  };
}
