import type {
  BrowserApiState,
  LauncherState,
} from "@openbot/shared/openbot-browser";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconPlayerRecordFilled,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useState } from "react";
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
import { browserStateQueryOptions } from "@/lib/browser/queries";
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
  const { counted, keep } = useActionsAtStop(recorder);
  /**
   * Why Record cannot be pressed yet, in a sentence, or null when it can. A Recorder that reports itself disconnected
   * does not hold Record back: the server connects the person's own browser again before it starts (a Disconnect in
   * Settings, Browsers leaves it signed out until then).
   */
  const waiting = !state.open
    ? "Your browser is closed. Open it to record."
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
    /** The recording Stop ended last, while nothing else is being recorded: what the page says after Stop. */
    stopped: stoppedRecording(phase, recorder?.lastStopped, counted),
    /** Why Record or Stop was refused, in the server's own sentence, and when it was asked (the latest of the page's
     * failures is the one it shows). */
    error: start.error ?? stop.error,
    failedAt: start.error
      ? start.submittedAt
      : stop.error
        ? stop.submittedAt
        : 0,
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
        // The count as Stop is pressed. The page reads it once a second, so an action taken just before Stop may not
        // have been read yet, and a recording that holds one must not be said to hold nothing. A read that fails leaves
        // the count the page read last.
        const now = await queryClient
          .fetchQuery({ ...browserStateQueryOptions(), retry: false })
          .catch(() => undefined);
        keep(now?.recorder);
      } finally {
        setFinishing(false);
      }
      stop.mutate();
    },
  };
}

export type Recording = ReturnType<typeof useRecording>;

/** A recording's actions as the page last read them while it ran. */
type Counted = { recordingId: string; actions: number };

/**
 * The Recorder's count of the person's actions in the recording running now, as the page last read it, kept once it
 * stops: the Recorder's report after Stop counts nothing (its count is the live recording's), so this is the only way
 * the page knows what the recording it stopped held. `keep` takes a report the page read for itself (at Stop). A count
 * never goes down within one recording, so a report read earlier never lowers one read later.
 */
function useActionsAtStop(recorder: LauncherState | undefined) {
  const [counted, setCounted] = useState<Counted | null>(null);
  const keep = useCallback((report: LauncherState | undefined) => {
    const recordingId =
      report?.phase === "recording" || report?.phase === "stopping"
        ? report.recordingId
        : undefined;
    if (!report || recordingId === undefined) return;
    setCounted((kept) =>
      kept?.recordingId === recordingId && kept.actions >= report.actions
        ? kept
        : { recordingId, actions: report.actions },
    );
  }, []);
  useEffect(() => keep(recorder), [keep, recorder]);
  return { counted, keep };
}

/**
 * The recording Stop ended last, while nothing else is being recorded, and whether it held nothing: the page read it
 * running and it never counted an action. A recording follows the tab Record started in and tabs opened from it, so
 * one where the person worked in another tab held nothing, and the Recorder still names it as sent (the fourth
 * end-to-end run: two such recordings reached Intelligence with no steps, and the page said both were saved). One the
 * page never saw running (stopped from the Recorder's own button while the page was closed) is taken as the Recorder
 * reports it.
 */
function stoppedRecording(
  phase: LauncherState["phase"],
  lastStopped: LauncherState["lastStopped"],
  counted: Counted | null,
) {
  if (phase !== "idle" || !lastStopped) return undefined;
  return {
    ...lastStopped,
    empty:
      counted?.recordingId === lastStopped.recordingId && counted.actions === 0,
  };
}

type Stopped = NonNullable<ReturnType<typeof stoppedRecording>>;

/** Why a recording can hold nothing, which the person can do something about next time. */
const FOLLOWS_ITS_TAB =
  "The Recorder follows the tab you started recording in, and tabs opened from it.";

/** What the page says once Stop ended a recording, naming it. */
function stoppedSentence(stopped: Stopped): string {
  return stopped.empty
    ? `Nothing was recorded in “${stopped.title}”. ${FOLLOWS_ITS_TAB}`
    : `Saved “${stopped.title}” to your Learning space.`;
}

function StoppedIcon({
  stopped,
  className,
}: {
  stopped: Stopped;
  className?: string;
}) {
  return stopped.empty ? (
    <IconAlertTriangle
      aria-hidden="true"
      className={cn("text-amber-600 dark:text-amber-400", className)}
    />
  ) : (
    <IconCircleCheck
      aria-hidden="true"
      className={cn("text-emerald-600 dark:text-emerald-400", className)}
    />
  );
}

/**
 * The recording Stop ended last, by name, on a page of rows (OpenBot Desktop), until the next one starts: Stop says
 * where the recording went, as the Recorder's own popup does, or that it held nothing.
 */
export function StoppedRow({ stopped }: { stopped: Stopped }) {
  return (
    <Item size="sm" role="status">
      <ItemMedia variant="icon">
        <StoppedIcon stopped={stopped} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{stopped.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {stopped.empty
            ? `Nothing was recorded. ${FOLLOWS_ITS_TAB}`
            : "Saved to your Learning space."}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/** The same, as a line under the bar above a browser shown in the page (hosted OpenBot). */
export function StoppedNotice({ stopped }: { stopped: Stopped }) {
  return (
    <p
      className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm"
      role="status"
    >
      <StoppedIcon stopped={stopped} className="size-4 shrink-0" />
      <span className="min-w-0">{stoppedSentence(stopped)}</span>
    </p>
  );
}

/** The red dot a recording carries, as a recording mark rather than a warning, in an icon's box so it lines up with
 * the icons of the rows around it. */
function RecordingMark({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center"
    >
      <span
        className={cn(
          "size-2.5 rounded-full",
          live
            ? "bg-destructive motion-safe:animate-pulse"
            : "bg-muted-foreground",
        )}
      />
    </span>
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
