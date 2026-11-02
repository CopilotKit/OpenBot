import type { RecorderPageState } from "@openbot/shared/recorder-page";
import { IconPlayerRecordFilled } from "@tabler/icons-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import {
  actionCount,
  elapsed,
  RecordingMark,
  StoppedIcon,
  stoppedRecording,
  stoppedSentence,
  useSecondsSince,
} from "./recording";

type ConnectedState = Extract<RecorderPageState, { connected: true }>;

/** What Record and Stop are doing, from the Browser button's own mutations. */
export type HereControls = {
  record(title: string): void;
  recordPending: boolean;
  stop(): void;
  stopPending: boolean;
  /** Why Record or Stop was refused, in the Recorder's own sentence. */
  error: Error | null;
};

/**
 * Focus for a control that has just replaced the one the person was using: Record gives way to Stop as the recording
 * starts, Stop to the task name as it ends, and the connect message to the task name once the Recorder is connected.
 * The control that had focus left with the content it was in, so focus fell to the document, or it was on the popover
 * itself, which is where Base UI puts it when the popover opens with nothing in it to focus. This puts it on the
 * control that took their place, where the keyboard can carry on. Anywhere else it is left where it is.
 */
function useFocusIfLost(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const control = ref.current;
    const active = document.activeElement;
    const popover = control?.closest("[data-slot=popover-content]");
    if (active === null || active === document.body || active === popover)
      control?.focus();
  }, [ref]);
}

/** A refusal, read out as it appears. */
function Refusal({ error }: { error: Error | null }) {
  return error ? (
    <p className="text-destructive text-sm" role="alert">
      {error.message}
    </p>
  ) : null;
}

/** How long it has run and how many actions it holds: 0:42 · 3 actions. */
function progress(
  state: ConnectedState,
  seconds: number,
  stopping: boolean,
): string {
  if (state.phase === "starting") return "Starting…";
  if (stopping || state.phase === "stopping") return "Stopping…";
  return `${elapsed(seconds)} · ${actionCount(state.actions)}`;
}

/**
 * Record and Stop in the popover from the sidebar's Browser button, for the Recorder in the browser OpenBot is open in,
 * read from its own report (`openbot.state`). Idle: a task name and Record, under what the last Stop saved, said as the
 * Browser page says it. Recording: its name, how long it has run, its actions and Stop. A narrow column, so each part
 * stands on its own line.
 */
export function RecordHerePanel({
  state,
  controls,
}: {
  state: ConnectedState;
  controls: HereControls;
}) {
  return state.phase === "idle" ? (
    <IdleHere controls={controls} state={state} />
  ) : (
    <RecordingHere controls={controls} state={state} />
  );
}

function RecordingHere({
  state,
  controls,
}: {
  state: ConnectedState;
  controls: HereControls;
}) {
  const stop = useRef<HTMLButtonElement>(null);
  useFocusIfLost(stop);
  const seconds = useSecondsSince(
    state.phase === "recording" ? state.startedAt : undefined,
  );
  return (
    <>
      <PopoverHeader>
        <PopoverTitle className="flex min-w-0 items-center gap-2">
          <RecordingMark live={state.phase === "recording"} />
          <span className="truncate">{state.title ?? "Recording"}</span>
        </PopoverTitle>
        <PopoverDescription className="tabular-nums" role="timer">
          {progress(state, seconds, controls.stopPending)}
        </PopoverDescription>
      </PopoverHeader>
      <Refusal error={controls.error} />
      <Button
        disabled={controls.stopPending || state.phase !== "recording"}
        onClick={() => controls.stop()}
        ref={stop}
        size="sm"
      >
        Stop
      </Button>
    </>
  );
}

function IdleHere({
  state,
  controls,
}: {
  state: ConnectedState;
  controls: HereControls;
}) {
  const [title, setTitle] = useState("");
  const name = useRef<HTMLInputElement>(null);
  useFocusIfLost(name);
  const stopped = stoppedRecording(state.phase, state.lastStopped);
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Record a task</PopoverTitle>
        <PopoverDescription>
          What you do in this browser goes into your own Learning space, in
          every tab you use, until you stop: your steps, what each step saves,
          AI assistant conversations, and your narration when it's on.
        </PopoverDescription>
      </PopoverHeader>
      {stopped ? (
        <p className="flex items-start gap-2" role="status">
          <StoppedIcon className="mt-0.5 size-4 shrink-0" stopped={stopped} />
          <span className="min-w-0">{stoppedSentence(stopped)}</span>
        </p>
      ) : null}
      <form
        aria-label="Record a task"
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const task = title.trim();
          if (!task || controls.recordPending) return;
          controls.record(task);
        }}
      >
        <Input
          aria-label="Task name"
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Name the task, like Submit an expense report"
          ref={name}
          value={title}
        />
        <Refusal error={controls.error} />
        {/* Base UI's Button defaults to type="button", which never submits the form. */}
        <Button
          disabled={!title.trim() || controls.recordPending}
          size="sm"
          type="submit"
        >
          <IconPlayerRecordFilled data-icon="inline-start" />
          {controls.recordPending ? "Starting…" : "Record"}
        </Button>
      </form>
    </>
  );
}

/** Where connecting the Recorder in this browser has got to. `idle`: no connect is under way (the Recorder stopped
 * being connected here while the popover was open, after a Disconnect in Settings, Browsers). `cancelled` and
 * `closed`: the person pressed Cancel on the Recorder's Connect page, or closed it. */
export type ConnectProgress =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "awaiting" }
  | { state: "expired" }
  | { state: "cancelled" }
  | { state: "closed" }
  | { state: "failed"; message: string };

function connectSentence(progress: ConnectProgress): string {
  switch (progress.state) {
    case "idle":
      return "The OpenBot Recorder in this browser isn't connected to OpenBot.";
    case "sending":
      return "Connecting this browser…";
    case "awaiting":
      return "Confirm in the OpenBot Recorder tab that opened.";
    case "expired":
      return "The request expired. Try again.";
    case "cancelled":
      return "You cancelled in the OpenBot Recorder tab. Nothing was connected.";
    case "closed":
      return "The OpenBot Recorder tab closed before you confirmed. Nothing was connected.";
    case "failed":
      return progress.message;
  }
}

/** The states the person can connect again from: a fresh Connect after nothing happened, Try again after a failure. */
const CONNECT_AGAIN: Partial<Record<ConnectProgress["state"], string>> = {
  idle: "Connect this browser",
  cancelled: "Connect this browser",
  closed: "Connect this browser",
  failed: "Try again",
  expired: "Try again",
};

/**
 * The popover while the Recorder in this browser is being connected to this OpenBot, which the first click on the
 * Browser button started: what is happening, the Recorder's refusal in its own sentence, or that the request ran out,
 * with a button to ask again.
 */
export function ConnectHerePanel({
  progress,
  connect,
}: {
  progress: ConnectProgress;
  connect(): void;
}) {
  const failed = progress.state === "failed";
  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Connect the OpenBot Recorder</PopoverTitle>
        <PopoverDescription
          className={failed ? "text-destructive" : undefined}
          role={failed ? "alert" : "status"}
        >
          {connectSentence(progress)}
        </PopoverDescription>
      </PopoverHeader>
      {CONNECT_AGAIN[progress.state] ? (
        <Button onClick={connect} size="sm" variant="outline">
          {CONNECT_AGAIN[progress.state]}
        </Button>
      ) : null}
    </>
  );
}
