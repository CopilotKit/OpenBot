/**
 * How long the audit trail is kept, said to Intelligence, which keeps it and enforces it.
 *
 * `AUDIT_RETENTION_DAYS` is still where a deployment says it (unset keeps the trail forever, the
 * default, because deleting somebody's trail because a default said so is the worse failure), and
 * Action Recording still keeps 90 days. The rows live in Intelligence now, so the windows go there at
 * boot (`PUT /api/audit/settings`, under the version just read) and Intelligence's own sweep removes
 * what is older. Its trail stays append-only exactly as this one was: a delete must declare the window
 * and cannot reach a row inside it.
 *
 * Not fatal at boot. A deployment must not fail to start because its retention could not be saved;
 * until it is, Intelligence keeps whatever it last had, and this says so and tries again every minute.
 */
import type { AuditTrailClient, RetentionSettings } from "./client";

export type RetentionWindows = Omit<RetentionSettings, "version">;

/** Make Intelligence's windows these. Answers whether anything had to change. */
export async function syncAuditRetention(
  client: Pick<AuditTrailClient, "settings" | "putSettings">,
  wanted: RetentionWindows,
): Promise<"unchanged" | "saved"> {
  // Another replica booting at the same moment may save first; read again and compare.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const current = await client.settings();
    if (
      current.eventRetentionDays === wanted.eventRetentionDays &&
      current.actionRetentionDays === wanted.actionRetentionDays
    ) {
      return "unchanged";
    }
    const saved = await client.putSettings(current.version, wanted);
    if (saved) {
      console.info(
        JSON.stringify({
          type: "audit-retention-set",
          eventRetentionDays: saved.eventRetentionDays,
          actionRetentionDays: saved.actionRetentionDays,
        }),
      );
      return "saved";
    }
  }
  throw new Error(
    "Intelligence's audit settings kept changing while this server tried to set its retention.",
  );
}

/** Sync now, and again every minute until it has worked once. */
export function startAuditRetentionSync(
  client: Pick<AuditTrailClient, "settings" | "putSettings">,
  wanted: RetentionWindows,
  options: { retryMs?: number } = {},
): { stop: () => void } {
  const retryMs = options.retryMs ?? 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const attempt = () => {
    syncAuditRetention(client, wanted).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          type: "audit-retention-not-set",
          note: "Intelligence has not been told this deployment's audit retention, so it keeps the trail by whatever it last had. Retrying.",
          wanted,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (stopped) return;
      timer = setTimeout(attempt, retryMs);
      timer.unref?.();
    });
  };
  attempt();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
