/**
 * What the Bot has been doing on its computer, beside the screen that shows what it is looking at.
 *
 * The screen answered half the question. A Bot that spends two minutes in a terminal installing a
 * package showed a blank browser and one grey line per command in the transcript, so the honest
 * answer to "what is it doing" was "something, on a machine holding your logins". This is the other
 * half: every command, what it printed, and what it exited with, as it happens.
 *
 * This session only. The record is the audit trail, which is on the server and survives a reload;
 * this is a window, and it is allowed to be empty when a tab is opened on a conversation that
 * already happened.
 *
 * The pane draws these among the Bot's browser steps, in one list (`step-log.tsx`). What is here is
 * what only a command log can say: what each call is called, how it ended, and what it printed.
 */
import type { ComputerActivity } from "@/lib/computers/activity";
import { CommandOutput } from "./command-output";

/**
 * What the line says was done, in the words the call's own line in the conversation uses
 * (`computer-tools.tsx`). The subject beside it says what it was done to.
 */
export const ACTIVITY_LABELS = {
  command: "Ran a command",
  read_file: "Read file",
  write_file: "Saved file",
  list_files: "Listed files",
} as const;

/** How a call ended: a boundary refused it, it exited non-zero, or it worked. */
export function activityStatus(
  entry: ComputerActivity,
): "done" | "blocked" | "failed" {
  if (entry.refused === true) return "blocked";
  if (typeof entry.exitCode === "number" && entry.exitCode !== 0)
    return "failed";
  return "done";
}

export function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** What came back: the refusal's reason, or what the call printed. */
export function ActivityOutput({ entry }: { entry: ComputerActivity }) {
  if (entry.refused === true)
    return (
      <p className="type-caption text-status-problem">
        {entry.output || "A boundary refused it."}
      </p>
    );
  return (
    <div className="max-h-64 overflow-auto">
      <CommandOutput
        {...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {})}
        output={entry.output}
        timedOut={entry.timedOut === true}
        truncated={entry.truncated === true}
      />
    </div>
  );
}
