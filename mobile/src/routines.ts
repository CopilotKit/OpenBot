import type { RoutineStatus } from "./api";
import { colors } from "./ui";

/** Run history in the words the routine page uses: Running, Succeeded, Failed. */
export const RUN_LABELS: Record<RoutineStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  waiting: "Waiting for you",
};
export const RUN_COLORS: Record<RoutineStatus, string> = {
  running: colors.link,
  succeeded: colors.success,
  failed: colors.error,
  skipped: colors.muted,
  waiting: colors.warning,
};
export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString() : "Not yet";
/** "Add routine" opens the Bot's conversation with this sentence started for the person to finish. */
export const ADD_ROUTINE_DRAFT = "Set up a routine to ";
