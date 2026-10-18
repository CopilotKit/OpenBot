import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { RecordedDemonstrations } from "@/components/demonstrations/recorded-demonstrations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  startDemonstrationMutationOptions,
  stopDemonstrationMutationOptions,
} from "@/lib/demonstrations/mutations";
import {
  demonstrationKeys,
  demonstrationsQueryOptions,
} from "@/lib/demonstrations/queries";
import { queryClient } from "@/query-client";

/** Seconds left before the server stops a recording, ticking once a second. */
function useSecondsLeft(expiresAt: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function DemonstrationRecorder({
  botId,
  driving,
  onRecordingChange,
}: {
  botId: string;
  driving: boolean;
  onRecordingChange: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState("");
  const recordings = useQuery(demonstrationsQueryOptions(botId));
  const active = recordings.data?.find(
    (recording) => recording.status === "recording",
  );
  const secondsLeft = useSecondsLeft(active?.expiresAt);
  /*
   * The server stops a recording at ten minutes. When the countdown runs out, or a poll shows the
   * active recording gone, re-read and reconnect the stream so it stops carrying the recording id.
   */
  const wasActive = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (wasActive.current && !active) onRecordingChange();
    wasActive.current = active?.id;
  }, [active, onRecordingChange]);
  useEffect(() => {
    if (secondsLeft === 0)
      void queryClient.invalidateQueries({
        queryKey: demonstrationKeys.bot(botId),
      });
  }, [secondsLeft, botId]);
  const start = useMutation(startDemonstrationMutationOptions(queryClient));
  const stop = useMutation(stopDemonstrationMutationOptions(queryClient));
  return (
    <section className="mt-4 grid gap-3 rounded-lg border p-4 text-left">
      <div>
        <h3 className="font-semibold">Teach a browser workflow</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Take control, record the steps, then review a skill draft. Typed
          values and images are omitted. Sensitive fields stay in your hands.
          Recording stops automatically after ten minutes.
        </p>
      </div>
      {active ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">
            Recording {active.title} · {active.actionCount} steps
          </span>
          {secondsLeft !== null && (
            <span
              aria-live={secondsLeft <= 60 ? "polite" : "off"}
              className={
                secondsLeft <= 60
                  ? "text-sm font-medium text-destructive tabular-nums"
                  : "text-sm text-muted-foreground tabular-nums"
              }
            >
              {secondsLeft > 0
                ? `${clock(secondsLeft)} left`
                : "Time limit reached. Stopping…"}
            </span>
          )}
          <Button
            size="sm"
            disabled={stop.isPending}
            onClick={() =>
              stop.mutate(active.id, { onSuccess: onRecordingChange })
            }
          >
            Stop recording
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            start.mutate({ botId, title }, { onSuccess: onRecordingChange });
          }}
        >
          <label htmlFor={id} className="grid grow gap-1 text-xs">
            Workflow name
            <Input
              id={id}
              required
              maxLength={120}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Find an invoice"
            />
          </label>
          {/* Base UI's Button defaults to type="button", which never submits the form. */}
          <Button
            size="sm"
            type="submit"
            disabled={!driving || start.isPending || !title.trim()}
          >
            Record your steps
          </Button>
          {!driving && (
            <p className="w-full text-xs text-muted-foreground">
              Take control of the browser to start recording.
            </p>
          )}
        </form>
      )}
      {(start.error || stop.error || recordings.error) && (
        <p role="alert" className="text-sm text-destructive">
          {start.error?.message ||
            stop.error?.message ||
            recordings.error?.message}
        </p>
      )}
      <RecordedDemonstrations botId={botId} />
    </section>
  );
}
