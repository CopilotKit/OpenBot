import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import { reasonWithoutStatement } from "../db/query-failure";
import type { RecorderConnectionStore } from "./connections";

/**
 * Ends every Recorder connection a person holds because their sign-in here is ending, saying how (`ending`): a sign-out,
 * sessions ended some other way, the person removed. Throws {@link RecorderSignOutFailed} when they could not be ended.
 */
export type SignOutRecorders = (
  userId: string,
  ending: string,
) => Promise<void>;

/**
 * A person's Recorder connections could not be ended, after every attempt. The sign-in that was ending must not end
 * without them: a session ended while a Recorder went on recording as the person is the half-done state the caller
 * refuses, so the person (or the administrator, or the directory) is told and can try again.
 */
export class RecorderSignOutFailed extends Error {
  constructor() {
    super("The person's Recorder connections could not be ended.");
    this.name = "RecorderSignOutFailed";
  }
}

/**
 * How long to wait before each attempt after the first. A failure here is the database refusing a write (a lost
 * connection, a deadlock, a statement timeout), which a moment usually clears; three tries inside a second keeps a
 * sign-out quick when it does not.
 */
const RETRY_PAUSES_MS = [100, 500] as const;

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ends a person's Recorder connections (and their unused connect codes) with `revokeAll`, retried. When every attempt
 * fails, `recorder.sign_out_failed` goes on the trail, a security row with how the sign-in was ending and the database's
 * complaint (never the query), and {@link RecorderSignOutFailed} is thrown. The row is written apart from the failed
 * transaction, and when the trail cannot take it either the failure is logged: the throw is what keeps the sign-in from
 * ending half-done, whichever of the two is down.
 */
export function createRecorderSignOut(deps: {
  connections: Pick<RecorderConnectionStore, "revokeAll">;
  auditStore?: AuditStore;
  /** Test seam: the waits between attempts. */
  pausesMs?: readonly number[];
}): SignOutRecorders {
  const pauses = deps.pausesMs ?? RETRY_PAUSES_MS;
  return async (userId, ending) => {
    let failure: unknown;
    for (let attempt = 0; attempt <= pauses.length; attempt += 1) {
      if (attempt > 0) await pause(pauses[attempt - 1] ?? 0);
      try {
        await deps.connections.revokeAll(userId, "signed_out", ending);
        return;
      } catch (error) {
        failure = error;
      }
    }
    const attempts = pauses.length + 1;
    const error = reasonWithoutStatement(failure);
    console.error(
      JSON.stringify({
        type: "recorder-sign-out-failed",
        ending,
        attempts,
        error,
      }),
    );
    if (deps.auditStore) {
      try {
        await recordAuditEvent(deps.auditStore, {
          eventType: "recorder.sign_out_failed",
          targetType: "person",
          targetId: userId,
          initiator: DEPLOYMENT_INITIATOR,
          payload: { ending, attempts, error },
        });
      } catch (rowError) {
        console.error(
          JSON.stringify({
            type: "recorder-audit-write-failed",
            eventType: "recorder.sign_out_failed",
            error: reasonWithoutStatement(rowError),
          }),
        );
      }
    }
    throw new RecorderSignOutFailed();
  };
}
