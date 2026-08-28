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
 */
import { IconFile, IconFolder, IconTerminal2 } from "@tabler/icons-react";
import { useSyncExternalStore } from "react";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  activityFor,
  type ComputerActivity,
  subscribeToActivity,
} from "@/lib/computers/activity";
import { CommandOutput } from "./command-output";

const ICONS = {
  command: IconTerminal2,
  read_file: IconFile,
  write_file: IconFile,
  list_files: IconFolder,
} as const;

/** What the line says was done. The subject beside it says what it was done to. */
const LABELS = {
  command: "Ran",
  read_file: "Read",
  write_file: "Saved",
  list_files: "Listed",
} as const;

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function Entry({ entry }: { entry: ComputerActivity }) {
  const Icon = ICONS[entry.kind];
  const failed =
    entry.refused === true ||
    (typeof entry.exitCode === "number" && entry.exitCode !== 0);

  return (
    <li className="border-border/60 border-b py-2 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <Icon
          aria-hidden
          className={`size-3.5 shrink-0 translate-y-0.5 ${
            failed ? "text-destructive" : "text-muted-foreground"
          }`}
        />
        <span className="shrink-0 text-muted-foreground text-xs">
          {LABELS[entry.kind]}
        </span>
        {/*
          The command wraps rather than truncating. In the transcript one line per call is what keeps
          it readable; here the whole point is to see exactly what ran, and a long command with its
          middle cut out is the one thing this pane must not do.
        */}
        <code className="min-w-0 break-all font-mono text-xs">
          {entry.subject}
        </code>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {timeOf(entry.at)}
        </span>
      </div>

      {entry.refused === true ? (
        <p className="mt-1 pl-5 text-destructive text-xs">
          {entry.output || "A boundary refused it."}
        </p>
      ) : (
        <div className="mt-1 max-h-64 overflow-auto pl-5">
          <CommandOutput
            {...(entry.exitCode !== undefined
              ? { exitCode: entry.exitCode }
              : {})}
            output={entry.output}
            timedOut={entry.timedOut === true}
            truncated={entry.truncated === true}
          />
        </div>
      )}
    </li>
  );
}

export function ActivityLog({ computerId }: { computerId: string }) {
  const entries = useSyncExternalStore(
    subscribeToActivity,
    () => activityFor(computerId),
    () => activityFor(computerId),
  );

  if (entries.length === 0) {
    return (
      <Empty className="h-[180px] border border-dashed">
        <EmptyHeader>
          <EmptyTitle className="text-muted-foreground">
            Nothing yet. Commands the Bot runs, and files it reads, appear here
            as they happen.
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  // Newest first: what somebody watching wants is what just happened, without scrolling for it.
  const newestFirst = [...entries].reverse();

  return (
    <ul className="min-w-0">
      {newestFirst.map((entry) => (
        <Entry entry={entry} key={entry.id} />
      ))}
    </ul>
  );
}
