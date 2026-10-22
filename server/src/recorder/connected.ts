import type { RecorderConnection } from "@openbot/shared/recorder-api";
import { type AuditStore, recordAuditEvent } from "../audit";

/** A Recorder audit row, written without ever failing the request that made it: a trail that could not be written is
 * logged, and the connection the person asked for still stands. */
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
              error: String(error),
            }),
          );
        })
      : Promise.resolve();
}

/**
 * What follows every new Recorder connection, however it was made (Connect this browser's exchange, or OpenBot opening
 * the person's own OpenBot browser): `recorder.connected` with how it was made, the person's Learning space made in
 * the background, and `recorder.revoked` for the older connection of the same copy it replaced.
 */
export async function recorderConnected(input: {
  made: {
    connection: RecorderConnection;
    userId: string;
    replaced: string | null;
  };
  audit: RecorderAudit;
  onConnected?: (userId: string) => void;
}): Promise<void> {
  const { made, audit } = input;
  await audit({
    eventType: "recorder.connected",
    targetType: "recorder_connection",
    targetId: made.connection.id,
    actorUserId: made.userId,
    payload: {
      connectionId: made.connection.id,
      via: made.connection.via,
      extensionId: made.connection.extensionId,
      installId: made.connection.installId,
      label: made.connection.label,
    },
  });
  try {
    input.onConnected?.(made.userId);
  } catch (error) {
    // Making the person's Learning space is a nicety here: the capture pass makes it too. Never fatal to connecting.
    console.error(
      JSON.stringify({
        type: "recorder-learning-space-kick-failed",
        error: String(error),
      }),
    );
  }
  if (made.replaced) {
    await audit({
      eventType: "recorder.revoked",
      targetType: "recorder_connection",
      targetId: made.replaced,
      actorUserId: made.userId,
      payload: { connectionId: made.replaced, reason: "replaced" },
    });
  }
}
