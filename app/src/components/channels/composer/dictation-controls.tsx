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
}: {
  dictation: Dictation;
  disabled: boolean;
}) {
  if (!dictation.available) return null;
  return (
    <Button
      aria-label="Dictate a message"
      title={
        dictation.supported
          ? "Dictate a message"
          : "Dictation requires a supported browser and HTTPS (or localhost)"
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
            "min-w-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none",
            dictation.busy
              ? "pointer-events-none -translate-y-1 opacity-0"
              : "translate-y-0 opacity-100",
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
