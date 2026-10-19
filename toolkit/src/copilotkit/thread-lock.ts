import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { ThreadLock } from "../ports";

/**
 * How long a conversation's lock is held before it lapses on its own.
 *
 * Matches the platform's own default rather than picking a number: this is renewed while a Bot works,
 * so what it really sets is how long a conversation stays stuck after a process dies mid-run.
 *
 * Advisory today: the platform applies its own fixed 120 seconds on acquire and renew whatever is
 * asked for (`THREAD_LOCK_TTL_SECONDS` in Intelligence's `apps/app-api/src/routes/thread-lock.ts`).
 * See `TURN_LIMITS` in `@openbot/toolkit/limits` for the headless turn's side of the same lock.
 */
export const THREAD_LOCK_TTL_SECONDS = 120;

/** The four platform calls the lock makes, and nothing else of the client. */
export type ThreadLockClient = Pick<
  CopilotKitIntelligence,
  | "getOrCreateThread"
  | "ɵacquireThreadLock"
  | "ɵrenewThreadLock"
  | "ɵcleanupThreadLock"
>;

/**
 * The conversation's run lock, as the platform issues it.
 *
 * ONE RUN AT A TIME PER CONVERSATION. Taken before anything is streamed, because the gateway
 * checks every event against the run the lock names: a run that skips this is claiming to be one
 * nobody was told about, and every event is refused. That refusal reads like a platform
 * limitation and is a missing step.
 *
 * A conversation somebody else is already running in refuses rather than queues, which is right:
 * the caller waits and tries again rather than two Bots writing over each other.
 */
export function createIntelligenceThreadLock(options: {
  client: ThreadLockClient;
  learning?: {
    containerForThread: (input: {
      agentId: string;
      threadId: string;
      userId: string;
    }) => Promise<string | undefined>;
  };
  onRunBusy?: (input: { threadId: string; busy: boolean }) => void;
}): ThreadLock {
  const { client, learning, onRunBusy } = options;
  return {
    acquire: async (input) => {
      try {
        const learningContainerId = await learning?.containerForThread(input);
        await client.getOrCreateThread({
          ...input,
          ...(learningContainerId ? { learningContainerId } : {}),
        });
        const held = await client.ɵacquireThreadLock({
          ...input,
          ...(learningContainerId ? { learningContainerId } : {}),
        });
        // A run started on this thread. Side effect only, never awaited: a channel showing it is
        // working is worth nothing next to the lock the run depends on.
        try {
          onRunBusy?.({ threadId: input.threadId, busy: true });
        } catch {}
        /*
         * The run id only. The lock also hands back a join token, which is what a browser presents
         * to watch the conversation; the runner's socket has its own credential and passing this
         * one in place of it means a socket that is refused and a run that never starts. See the
         * note on `runner.run` in handoff-delivery.ts.
         */
        return { runId: held.runId };
      } catch (error) {
        /*
         * ONLY A CONFLICT MEANS "NOT NOW". Everything else is raised.
         *
         * A conversation somebody is already running in answers 409, and that is ordinary: the hop
         * waits and is tried again. Anything else is not — a platform that cannot be reached, a
         * token that stopped working, or one of the underscored APIs below being renamed by a
         * routine version bump. Returned as `null` those all read as contention: every hop retries
         * to exhaustion, every person is told their question was never answered, and the only
         * evidence is a warning line that looks like a busy conversation.
         *
         * Raised, the runner writes the real reason onto `agent.handoff_failed`, and the sentence
         * the person eventually gets names it.
         */
        const status =
          error instanceof Error && "status" in error
            ? (error as { status?: unknown }).status
            : undefined;
        if (status === 409) return null;
        throw error;
      }
    },
    renew: async (input) => {
      await client.ɵrenewThreadLock({
        ...input,
        ttlSeconds: THREAD_LOCK_TTL_SECONDS,
      });
    },
    release: async (input) => {
      // The run on this thread is over. Cleared here rather than trusting a browser: the run may
      // have outlived the tab that started it, and this is where the platform is told it ended.
      try {
        onRunBusy?.({ threadId: input.threadId, busy: false });
      } catch {}
      await client.ɵcleanupThreadLock(input);
    },
  };
}
