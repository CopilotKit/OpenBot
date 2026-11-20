import { colors } from "./colors";

/** Run history in the words the routine page uses: Running, Succeeded, Failed. */
const RUN_LABELS: Record<string, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  waiting: "Waiting for you",
};
const RUN_COLORS: Record<string, string> = {
  running: colors.link,
  succeeded: colors.success,
  failed: colors.error,
  skipped: colors.muted,
  waiting: colors.warning,
};

/** A run's status in words. Null for one a newer server sends that this app doesn't know. */
export function runLabel(status: string): string | null {
  return RUN_LABELS[status] ?? null;
}

/** A run's status as a colour, muted for one this app doesn't know. */
export function runColor(status: string | null | undefined): string {
  return (status && RUN_COLORS[status]) || colors.muted;
}

/** The Bot screen's line about a routine's last run. Null when there is none, or its status is unknown. */
export function lastRunLine(status: string | null | undefined): string | null {
  const label = status ? runLabel(status) : null;
  return label ? `Last run: ${label}` : null;
}

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString() : "Not yet";
/** "Add routine" opens the Bot's conversation with this sentence started for the person to finish. */
export const ADD_ROUTINE_DRAFT = "Set up a routine to ";
