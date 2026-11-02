import { type AuditStore, recordAuditEvent } from "../audit";
import { reasonWithoutStatement } from "../db/query-failure";

/**
 * A Recorder refusal's audit row (`recorder.connect_refused`). The refusal is decided before the row is written and
 * stands either way, since nothing was granted, so a row that could not be written does not change the answer: it is
 * logged, naming the event, where an operator reads failures. The rows for a connection made or ended are not written
 * here: they go in the transaction that makes the change (connections.ts), so a change whose row cannot be written does
 * not happen.
 */
export type RecorderAudit = (
  event: Parameters<typeof recordAuditEvent>[1],
) => Promise<void>;

export function recorderAudit(
  auditStore: AuditStore | undefined,
): RecorderAudit {
  return (event) =>
    auditStore
      ? recordAuditEvent(auditStore, event).catch((error: unknown) => {
          console.error(
            JSON.stringify({
              type: "recorder-audit-write-failed",
              eventType: event.eventType,
              // A failed query's message carries the values bound to it: never logged.
              error: reasonWithoutStatement(error),
            }),
          );
        })
      : Promise.resolve();
}

/**
 * What follows every new Recorder connection, however it was made (Connect this browser's exchange, or OpenBot opening
 * the person's own OpenBot browser or recording in a Bot's browser), once its rows are written with it: the person's
 * Learning space made in the background.
 */
export function recorderConnected(input: {
  userId: string;
  onConnected?: (userId: string) => void;
}): void {
  try {
    input.onConnected?.(input.userId);
  } catch (error) {
    // Making the person's Learning space is a nicety here: the capture pass makes it too. Never fatal to connecting.
    console.error(
      JSON.stringify({
        type: "recorder-learning-space-kick-failed",
        error: String(error),
      }),
    );
  }
}
