import type {
  BrowserApiState,
  LauncherState,
} from "@openbot/shared/openbot-browser";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconPlayerRecordFilled,
} from "@tabler/icons-react";
import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
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
import type { NarrationChoice } from "./narration-choice";

/** The language narration is heard in: the person's own browser's. */
export function narrationLanguage(): string {
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}

/** Seconds since `startedAt`, ticking once a second while there is one. */
export function useSecondsSince(startedAt: number | undefined) {
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

export const actionCount = (actions: number) =>
  `${actions} ${actions === 1 ? "action" : "actions"}`;
const phraseCount = (phrases: number) =>
  `${phrases} narrated ${phrases === 1 ? "phrase" : "phrases"}`;

/** What Record and Stop do around the recording itself, on a screen. */
export type RecordingHooks = {
  /**
   * Runs first on Stop. On a screen it hands over the phrase being said, so the last thing the person said is in the
   * recording before it ends.
   */
  beforeStop?: () => Promise<void>;
  /** Hears the answer to the narration question on the person's click, where narration in the page needs it. */
  answered?: (narrate: boolean) => void;
};

/**
 * Record and Stop for the person's browser, from the Recorder's own report in `state`. Record asks about narration
 * first when the person has never said (`useRecordingWith`).
 */
export function useRecording(
  state: BrowserApiState,
  choice: NarrationChoice,
  hooks: RecordingHooks = {},
) {
  return useRecordingWith({
    recorder: state.recorder,
    /*
     * A Recorder that reports itself disconnected does not hold Record back: the server connects the person's own
     * browser again before it starts (a Disconnect in Settings, Browsers leaves it signed out until then).
     */
    waiting: !state.open ? "Your browser is closed. Open it to record." : null,
    start: startBrowserRecordingMutationOptions(queryClient),
    stop: stopBrowserRecordingMutationOptions(queryClient),
    choice,
    ...hooks,
  });
}

/** What Record posts: the task's name, the language narration is heard in, and whether the person narrates it. */
export type RecordingStart = {
  title: string;
  language?: string;
  narrate?: boolean;
};

/**
 * Record and Stop for any browser the Recorder is in, from its own report (`recorder`): the person's own browser
 * (`useRecording`), or a Bot's (`components/computer/bot-browser.tsx`), whose routes take the same bodies.
 *
 * `waiting` is why Record cannot be pressed yet, in a sentence, or null when it can.
 *
 * Record asks the person whether to narrate when they have never said (`choice`, their account's preference, the same
 * in every browser they record in), in a dialog whose answer records and is kept, and tells the Recorder the answer
 * with every recording, so a microphone opens only for a person who chose to narrate.
 */
export function useRecordingWith<Started, Stopped>({
  recorder,
  waiting,
  start: startOptions,
  stop: stopOptions,
  choice,
  beforeStop,
  answered,
}: {
  recorder: LauncherState | undefined;
  waiting: string | null;
  start: UseMutationOptions<Started, Error, RecordingStart>;
  stop: UseMutationOptions<Stopped, Error, void>;
  choice: NarrationChoice;
} & RecordingHooks) {
  const [title, setTitle] = useState("");
  const [finishing, setFinishing] = useState(false);
  /** The narration question is on screen, for the task named when Record was pressed. */
  const [asking, setAsking] = useState(false);
  const start = useMutation(startOptions);
  const stop = useMutation(stopOptions);
  const phase = recorder?.phase ?? "idle";
  const seconds = useSecondsSince(
    phase === "recording" ? recorder?.startedAt : undefined,
  );

  function begin(name: string, narrate: boolean) {
    stop.reset();
    start.mutate(
      { title: name, language: narrationLanguage(), narrate },
      { onSuccess: () => setTitle("") },
    );
  }

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
    stopped: stoppedRecording(phase, recorder?.lastStopped),
    /** Why Record or Stop was refused, in the server's own sentence, and when it was asked (the latest of the page's
     * failures is the one it shows). */
    error: start.error ?? stop.error,
    startError: start.error,
    stopError: stop.error,
    failedAt: start.error
      ? start.submittedAt
      : stop.error
        ? stop.submittedAt
        : 0,
    async record() {
      const name = title.trim();
      if (!name) return;
      // Asked only of a person who never chose: a choice the page has not heard yet is read first.
      const narration = await choice.read();
      if (narration === null) {
        setAsking(true);
        return;
      }
      // Unreadable: recorded without narration, the microphone closed, and the choice left as it is.
      begin(name, narration === "on");
    },
    /** The narration question, while it is asked: its dialog's props. */
    question: {
      open: asking,
      onAnswer(narrate: boolean) {
        setAsking(false);
        choice.choose(narrate);
        answered?.(narrate);
        const name = title.trim();
        if (name) begin(name, narrate);
      },
      onClose: () => setAsking(false),
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

/**
 * The recording Stop ended last, while nothing else is being recorded, and whether it held nothing: the Recorder
 * counted none of the person's actions in it and kept none of their narrated phrases. Read from the Recorder's own
 * report, which names what it held, so a reload says the same. The fourth end-to-end run saw recordings with no steps
 * said to be saved; the fifth saw one of narration alone said to hold nothing, from the only count the page had then,
 * the actions it read while the recording ran.
 */
export function stoppedRecording(
  phase: LauncherState["phase"],
  lastStopped: LauncherState["lastStopped"],
) {
  if (phase !== "idle" || !lastStopped) return undefined;
  return {
    ...lastStopped,
    empty: lastStopped.actions === 0 && lastStopped.phrases === 0,
  };
}

export type Stopped = NonNullable<ReturnType<typeof stoppedRecording>>;

/** What a recording holds, which the person can go by next time: the browser's own pages (a new tab, its settings)
 * and the sites they leave out are never recorded (@openbot/shared/recorder-disclosure says it in full). */
const WHAT_IT_RECORDS =
  "The Recorder records the pages you open on websites and what you do there, with what each step saves, AI assistant conversations and your narration, in every tab you use while it records, except sites you leave out.";

/** What Record does, said before it is pressed: everything a recording holds, as the disclosure says it. */
export const RECORDING_DESCRIPTION =
  "Do the task in your browser as you always would. The Recorder records every tab you use until you stop, and each tab shows that it is: the pages and what is on them, your clicks and typing, what each step saves, AI assistant conversations, and your narration when it's on. Passwords, card numbers, email addresses and tokens are masked first.";

/** What a saved recording held: its actions, and its narrated phrases when there were any. */
function heldIn(stopped: Stopped): string {
  return stopped.phrases > 0
    ? `${actionCount(stopped.actions)} and ${phraseCount(stopped.phrases)}`
    : actionCount(stopped.actions);
}

/** What the page says once Stop ended a recording, naming it. The sidebar's Browser button says the same. */
export function stoppedSentence(stopped: Stopped): string {
  return stopped.empty
    ? `Nothing was recorded in “${stopped.title}”. ${WHAT_IT_RECORDS}`
    : `Saved “${stopped.title}” to your Learning space: ${heldIn(stopped)}.`;
}

export function StoppedIcon({
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
 * The recording Stop ended last, by name, on a page of rows (OpenBot Desktop, a Bot's screen), until the next one
 * starts: Stop says where the recording went and what it held, or that it held nothing. `ended` comes first when
 * something other than Stop ended it, in a sentence saying what did.
 */
export function StoppedRow({
  stopped,
  ended,
}: {
  stopped: Stopped;
  ended?: string;
}) {
  const held = stopped.empty
    ? `Nothing was recorded. ${WHAT_IT_RECORDS}`
    : `Saved to your Learning space: ${heldIn(stopped)}.`;
  return (
    <Item size="sm" role="status">
      <ItemMedia variant="icon">
        <StoppedIcon stopped={stopped} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{stopped.title}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {ended ? `${ended} ${held}` : held}
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
 * the icons of the rows around it. The sidebar's Browser button carries the same one. */
export function RecordingMark({ live }: { live: boolean }) {
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
 * The recording row on a page of rows (OpenBot Desktop, a Bot's screen): a task name and Record, or while recording its
 * name, how long it has run, its actions and Stop. `placeholder` is shorter where the row is narrow (the column beside
 * a Bot's screen), so the field says what it is for rather than half an example.
 */
export function RecordingRow({
  recording,
  placeholder = "Name the task, like Submit an expense report",
}: {
  recording: Recording;
  placeholder?: string;
}) {
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
            void recording.record();
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
          placeholder={placeholder}
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
        void recording.record();
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
