/** Run history in the words the routine page uses: Running, Succeeded, Failed. */
const RUN_LABELS: Record<string, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  waiting: "Waiting for you",
};
/** A run's status as the tone its words are drawn in (`Text`'s `tone`). */
export type RunTone = "default" | "muted" | "danger" | "success" | "warning";
const RUN_TONES: Record<string, RunTone> = {
  running: "default",
  succeeded: "success",
  failed: "danger",
  skipped: "muted",
  waiting: "warning",
};

/** A run's status in words. Null for one a newer server sends that this app doesn't know. */
export function runLabel(status: string): string | null {
  return RUN_LABELS[status] ?? null;
}

/** A run's status as a tone, muted for one this app doesn't know. */
export function runTone(status: string | null | undefined): RunTone {
  return (status && RUN_TONES[status]) || "muted";
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
