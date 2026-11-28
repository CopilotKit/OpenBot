import type { QueryClient } from "@tanstack/react-query";
import { clientRequest } from "@/lib/client";
import type { PendingWrite } from "./renewal";

/** What sending again came to, in the words the page says it in. */
export type ReplayOutcome = { done: true } | { done: false; said: string };

const FAILED = "What you were doing didn't finish. Try again.";

/**
 * Send again the write a renewal interrupted, once, exactly as it was sent: the same address,
 * method, body and Idempotency-Key. A write that did land the first time is answered as a repeat,
 * never done twice. Then everything the page holds is read again, so it shows what the write
 * changed. A refusal comes back in the server's own words.
 */
export async function replayPendingWrite(
  write: PendingWrite,
  queryClient: QueryClient,
): Promise<ReplayOutcome> {
  try {
    await clientRequest(
      write.path,
      {
        method: write.method,
        headers: write.headers,
        ...(write.body === undefined ? {} : { body: write.body }),
      },
      FAILED,
    );
    return { done: true };
  } catch (error) {
    return {
      done: false,
      said: error instanceof Error ? error.message : FAILED,
    };
  } finally {
    await queryClient.invalidateQueries();
  }
}
