import {
  IconArrowUp,
  IconLoader2,
  IconMicrophone,
  IconPlayerStopFilled,
  IconX,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { useDictation } from "./use-dictation";

type Dictation = ReturnType<typeof useDictation>;

export function DictationButton({
  dictation,
  disabled,
  onStarted,
}: {
  dictation: Dictation;
  disabled: boolean;
  /** Live dictation began: the caret goes to the box, so Enter stops it there. */
  onStarted?: () => void;
}) {
  if (!dictation.available) return null;
  if (dictation.mode === "live")
    return (
      <LiveDictationButton
        dictation={dictation}
        disabled={disabled}
        onStarted={onStarted}
      />
    );
  return (
    <Button
      aria-label="Dictate a message"
      data-slot="composer-dictate"
      title={
        dictation.supported
          ? "Dictate a message"
          : "Dictation needs a supported browser and a secure (HTTPS) connection"
      }
      className="size-8 shrink-0 self-end rounded-full"
      disabled={disabled || !dictation.supported || dictation.busy}
      onClick={() => void dictation.session.start()}
      size="icon"
      type="button"
      variant="ghost"
    >
      <IconMicrophone className="size-4" />
    </Button>
  );
}

/**
 * LIVE DICTATION'S ONE BUTTON. The microphone starts it, and while it listens the same button is Stop,
 * in the same place and size, so the way out is where the way in was. Stopping keeps every word in
 * the box and sends nothing; Enter in the box does the same.
 */
function LiveDictationButton({
  dictation,
  disabled,
  onStarted,
}: {
  dictation: Dictation;
  disabled: boolean;
  onStarted?: () => void;
}) {
  const { session, state, active } = dictation.live;
  if (!active)
    return (
      <Button
        aria-label="Dictate a message"
        data-slot="composer-dictate"
        title="Dictate a message"
        className="size-8 shrink-0 self-end rounded-full"
        disabled={disabled}
        onClick={() => {
          void session.start();
          onStarted?.();
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        <IconMicrophone className="size-4" />
      </Button>
    );
  const stopping = state.phase === "stopping";
  return (
    <Button
      aria-label={stopping ? "Finishing dictation" : "Stop dictation"}
      data-slot="composer-dictate-stop"
      data-state={state.phase}
      title="Stop dictation"
      className="relative size-8 shrink-0 self-end rounded-full bg-muted text-foreground hover:bg-muted"
      disabled={stopping}
      onClick={session.stop}
      size="icon"
      type="button"
      variant="ghost"
    >
      {state.phase === "listening" && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-primary/40 motion-safe:animate-pulse"
        />
      )}
      {/*
       * No fade-in on the icon. Motion starts it at opacity 0 and needs animation frames to show it,
       * and a Desktop window behind other windows gets none: Stop was there and could not be seen.
       */}
      {stopping ? (
        <IconLoader2
          aria-hidden="true"
          className="size-4 motion-safe:animate-spin"
        />
      ) : (
        <IconPlayerStopFilled className="size-3.5" />
      )}
    </Button>
  );
}

/** What live dictation says above the box: that it is listening, waiting on the system, or a problem. */
export function LiveDictationNotice({ dictation }: { dictation: Dictation }) {
  const { state, session } = dictation.live;
  if (dictation.mode !== "live") return null;
  if (state.phase === "listening" || state.phase === "stopping")
    return (
      <span className="sr-only" role="status">
        {state.phase === "listening" ? "Listening" : "Finishing dictation"}
      </span>
    );
  if (state.phase === "preparing")
    return (
      <p className="pb-2 text-sm text-muted-foreground" role="status">
        Waiting for permission to use the microphone and speech recognition.
      </p>
    );
  if (state.phase !== "error") return null;
  return (
    <div className="flex items-start gap-2 pb-2">
      <p
        className="min-w-0 flex-1 text-sm text-destructive"
        data-slot="composer-dictate-error"
        role="alert"
      >
        {state.error}
      </p>
      <Button
        aria-label="Dismiss"
        className="shrink-0"
        onClick={session.release}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <IconX />
      </Button>
    </div>
  );
}

/** Keep the editor mounted and its footprint stable while recording takes its place. */
export function DictationSurface({
  dictation,
  canSend,
  children,
  className,
}: {
  dictation: Dictation;
  canSend: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="relative min-w-0">
        <div
          aria-hidden={dictation.busy || undefined}
          inert={dictation.busy}
          className={cn(
            /*
             * NO TRANSLATE AT REST, NOT EVEN ZERO. Tailwind's `translate-y-0` sets the `translate`
             * property to `0px`, which is not `none`, and any translate makes this box the containing
             * block for `position: fixed` descendants. The @ menu is one: it is placed at the caret in
             * viewport coordinates, and was drawn that far again from this box's corner, off the bottom
             * of the screen. The idle state therefore names no translate at all.
             *
             * `translate` in the transition list, not `transform`: Tailwind v4's translate utilities
             * set the `translate` property, so a transition on `transform` never animated the lift.
             */
            "min-w-0 transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none motion-reduce:translate-none",
            dictation.busy
              ? "pointer-events-none -translate-y-1 opacity-0"
              : "opacity-100",
          )}
        >
          {children}
        </div>
        {dictation.busy && (
          <RecordingControls dictation={dictation} canSend={canSend} />
        )}
      </div>
    </div>
  );
}

function RecordingControls({
  dictation,
  canSend,
}: {
  dictation: Dictation;
  canSend: boolean;
}) {
  const { state, session } = dictation;
  const reduceMotion = useReducedMotion();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  const recording = state.phase === "recording";
  const transcribing = state.phase === "transcribing";
  const transition = {
    duration: reduceMotion ? 0 : ENTRANCE_SECONDS,
    ease: EASE_OUT,
  };
  const arrive = { opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 3 };
  const time = `${Math.floor(state.seconds / 60)}:${String(state.seconds % 60).padStart(2, "0")}`;
  return (
    <motion.div
      initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
      className="absolute inset-0 flex min-w-0 items-center gap-3"
    >
      <Button
        ref={cancel}
        aria-label="Cancel dictation"
        data-slot="composer-dictate-cancel"
        title="Cancel dictation"
        size="icon"
        type="button"
        variant="ghost"
        className="size-8 shrink-0 rounded-full"
        onClick={session.cancel}
      >
        <IconX className="size-4" />
      </Button>
      <motion.div
        key={
          state.phase === "error" || state.phase === "requesting"
            ? state.phase
            : "waveform"
        }
        initial={arrive}
        animate={{ opacity: 1, y: 0 }}
        transition={transition}
        className="max-h-full min-w-0 flex-1 overflow-y-auto"
      >
        {state.phase === "error" ? (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        ) : state.phase === "requesting" ? (
          <p className="text-sm text-muted-foreground" role="status">
            Waiting for microphone permission…
          </p>
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            <span className="sr-only" role="status">
              {transcribing ? "Transcribing…" : "Listening"}
            </span>
            <LiveWaveform
              stream={state.stream}
              processing={transcribing}
              height={28}
              className="flex-1 text-foreground"
            />
            <span
              role="timer"
              aria-label="Recording duration"
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
            >
              {time}
            </span>
          </div>
        )}
      </motion.div>
      <motion.div
        key={state.phase === "error" ? "recovery" : "actions"}
        initial={arrive}
        animate={{ opacity: 1, y: 0 }}
        transition={transition}
        className="shrink-0"
      >
        {state.phase === "error" ? (
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() =>
              void (state.canRetry ? session.retry() : session.start())
            }
          >
            {state.canRetry ? "Retry" : "Record again"}
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              aria-label="Stop and transcribe"
              data-slot="composer-dictate-stop"
              title="Stop and add to draft"
              disabled={!recording}
              size="icon"
              type="button"
              variant="ghost"
              className="size-8 rounded-full"
              onClick={() => void session.finish("draft")}
            >
              <IconPlayerStopFilled className="size-3.5" />
            </Button>
            <Button
              aria-label="Transcribe and send"
              title="Transcribe and send"
              disabled={!recording || !canSend}
              size="icon"
              type="button"
              className="size-8 rounded-full"
              onClick={() => void session.finish("send")}
            >
              <motion.span
                key={transcribing ? "transcribing" : "send"}
                initial={{
                  opacity: reduceMotion ? 1 : 0,
                  scale: reduceMotion ? 1 : 0.85,
                }}
                animate={{ opacity: 1, scale: 1 }}
                transition={transition}
                className="flex"
              >
                {transcribing ? (
                  <IconLoader2
                    aria-hidden="true"
                    className="size-4 motion-safe:animate-spin"
                  />
                ) : (
                  <IconArrowUp className="size-4" />
                )}
              </motion.span>
            </Button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
