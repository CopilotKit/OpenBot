import type { BrowserApiState } from "@openbot/shared/openbot-browser";
import { IconPlayerRecordFilled } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  startBrowserRecordingMutationOptions,
  stopBrowserRecordingMutationOptions,
} from "@/lib/browser/mutations";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/** The language narration is heard in: the person's own browser's. */
export function narrationLanguage(): string {
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

/** Seconds since `startedAt`, ticking once a second while there is one. */
function useSecondsSince(startedAt: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return 0;
  // The Recorder's clock is the browser's machine's, which can run a moment ahead of this one.
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** 0:42, 12:05, 1:02:09. */
export function elapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

const actionCount = (actions: number) =>
  `${actions} ${actions === 1 ? "action" : "actions"}`;

/**
 * Record and Stop for the person's browser, from the Recorder's own report in `state`.
 *
 * `beforeStop` runs first on Stop. On a screen it hands over the phrase being said, so the last thing the person said
 * is in the recording before it ends.
 */
export function useRecording(
  state: BrowserApiState,
  beforeStop?: () => Promise<void>,
) {
  const [title, setTitle] = useState("");
  const [finishing, setFinishing] = useState(false);
  const start = useMutation(startBrowserRecordingMutationOptions(queryClient));
  const stop = useMutation(stopBrowserRecordingMutationOptions(queryClient));
  const recorder = state.recorder;
  const phase = recorder?.phase ?? "idle";
  const seconds = useSecondsSince(
    phase === "recording" ? recorder?.startedAt : undefined,
  );
  /** Why Record cannot be pressed yet, in a sentence, or null when it can. */
  const waiting = !state.open
    ? "Your browser is closed. Open it to record."
    : !recorder?.connected
      ? "The Recorder is still connecting."
      : null;

  return {
    phase,
    title,
    setTitle,
    recordingTitle: recorder?.title ?? title,
    seconds,
    actions: recorder?.actions ?? 0,
    waiting,
    canRecord:
      waiting === null &&
      phase === "idle" &&
      !start.isPending &&
      !!title.trim(),
    starting: start.isPending || phase === "starting",
    stopping: finishing || stop.isPending || phase === "stopping",
    error: start.error ?? stop.error,
    record() {
      const name = title.trim();
      if (!name) return;
      stop.reset();
      start.mutate(
        { title: name, language: narrationLanguage() },
        { onSuccess: () => setTitle("") },
      );
    },
    async stop() {
      start.reset();
      setFinishing(true);
      try {
        await beforeStop?.();
      } finally {
        setFinishing(false);
      }
      stop.mutate();
    },
  };
}

export type Recording = ReturnType<typeof useRecording>;

/** The red dot a recording carries, as a recording mark rather than a warning. */
function RecordingMark({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        live
          ? "bg-destructive motion-safe:animate-pulse"
          : "bg-muted-foreground",
      )}
    />
  );
}

/** The line under a recording's name: how long it has run and how many actions it holds. */
function progressLine(recording: Recording): string {
  if (recording.phase === "starting") return "Starting…";
  if (recording.stopping) return "Stopping…";
  return `${elapsed(recording.seconds)} · ${actionCount(recording.actions)}`;
}

/**
 * The recording row on a page of rows (OpenBot Desktop): a task name and Record, or while recording its name, how long
 * it has run, its actions and Stop.
 */
export function RecordingRow({ recording }: { recording: Recording }) {
  if (recording.phase !== "idle") {
    return (
      <Item size="sm">
        <ItemMedia variant="icon">
          <RecordingMark live={recording.phase === "recording"} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{recording.recordingTitle}</ItemTitle>
          <ItemDescription role="timer" className="tabular-nums">
            {progressLine(recording)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            size="sm"
            disabled={recording.stopping || recording.phase !== "recording"}
            onClick={() => void recording.stop()}
          >
            Stop
          </Button>
        </ItemActions>
      </Item>
    );
  }
  return (
    <Item
      size="sm"
      render={
        <form
          aria-label="Record a task"
          onSubmit={(event) => {
            event.preventDefault();
            recording.record();
          }}
        />
      }
    >
      <ItemMedia variant="icon">
        <IconPlayerRecordFilled className="text-destructive" />
      </ItemMedia>
      <ItemContent>
        <Input
          aria-label="Task name"
          maxLength={200}
          onChange={(event) => recording.setTitle(event.target.value)}
          placeholder="Name the task, like Submit an expense report"
          value={recording.title}
        />
        {recording.waiting ? (
          <ItemDescription>{recording.waiting}</ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        {/* Base UI's Button defaults to type="button", which never submits the form. */}
        <Button disabled={!recording.canRecord} size="sm" type="submit">
          {recording.starting ? "Starting…" : "Record"}
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * The same controls in one line, for the bar above a browser shown in the page (hosted OpenBot). `children` sits
 * before Stop while recording: the narration switch.
 */
export function RecordingBar({
  recording,
  children,
}: {
  recording: Recording;
  children?: ReactNode;
}) {
  if (recording.phase !== "idle") {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <RecordingMark live={recording.phase === "recording"} />
          <span className="truncate font-medium">
            {recording.recordingTitle}
          </span>
          <span
            role="timer"
            className="shrink-0 text-muted-foreground tabular-nums"
          >
            {progressLine(recording)}
          </span>
        </span>
        {children}
        <Button
          size="sm"
          disabled={recording.stopping || recording.phase !== "recording"}
          onClick={() => void recording.stop()}
        >
          Stop
        </Button>
      </div>
    );
  }
  return (
    <form
      aria-label="Record a task"
      className="flex min-w-0 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        recording.record();
      }}
    >
      <Input
        aria-label="Task name"
        className="h-7 w-64 min-w-0"
        maxLength={200}
        onChange={(event) => recording.setTitle(event.target.value)}
        placeholder="Name the task to record"
        title={recording.waiting ?? undefined}
        value={recording.title}
      />
      {children}
      <Button disabled={!recording.canRecord} size="sm" type="submit">
        <IconPlayerRecordFilled data-icon="inline-start" />
        {recording.starting ? "Starting…" : "Record"}
      </Button>
    </form>
  );
}
