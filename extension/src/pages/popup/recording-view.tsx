import {
  IconCircleCheck,
  IconCloudUpload,
  IconDatabaseOff,
  IconExternalLink,
  IconListCheck,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { PageRows } from "@/components/layout/page-parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import type { RecorderState } from "../../protocol/messages";
import {
  CaptureRows,
  recordingLearningSentence,
  SendingLearningRow,
  stripCaptureStatus,
} from "../ui/capture-rows";

/** The sentence the service worker sets while OpenBot has not yet heard of a Stop. */
export const STOP_PENDING_PREFIX = "Stopping: OpenBot did not answer yet.";

export function isStopPending(error: string | undefined): boolean {
  return error?.startsWith(STOP_PENDING_PREFIX) ?? false;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function elapsed(startedAt: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export type RecordingActions = {
  onStop: () => void;
  onRestart: () => void;
  onNotice: (choice: "stop" | "restart" | "continue") => void;
};

/** What the popup shows while a recording runs: time, steps, the capture rows, and Stop or Start over. */
export function RecordingView({
  state,
  busy,
  actions,
}: {
  state: RecorderState;
  busy: boolean;
  actions: RecordingActions;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const stopping = state.phase === "stopping" || state.phase === "starting";
  return (
    <>
      <div className="mt-6">
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconListCheck />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{state.title ?? "Recording"}</ItemTitle>
              <ItemDescription>
                {state.phase === "starting"
                  ? "Starting the recording"
                  : state.phase === "stopping"
                    ? "Stopping the recording"
                    : `${elapsed(state.startedAt, now)} · ${plural(state.steps, "step", "steps")}`}
              </ItemDescription>
            </ItemContent>
          </Item>
          {/* The service worker says while it is open: any choice, in a tab or here, Stop and Start over close it, and
              its buttons wait while a choice is being sent, as the card stays until the next state says so. */}
          {state.noticeOpen ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{`You have recorded ${state.steps} steps`}</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    Click Stop if the task is done, start over if it went wrong,
                    or keep going if it needs more.
                  </ItemDescription>
                </ItemContent>
                <ItemFooter className="justify-end">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => actions.onNotice("stop")}
                  >
                    Stop
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => actions.onNotice("restart")}
                  >
                    Start over
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => actions.onNotice("continue")}
                  >
                    Keep going
                  </Button>
                </ItemFooter>
              </Item>
            </>
          ) : null}
        </PageRows>
      </div>
      {state.phase === "starting" ? null : (
        <div className="mt-6">
          <CaptureRows capture={state.capture} learning={state.learning} />
        </div>
      )}
      <div className="mt-6 flex flex-col gap-2">
        <Button size="lg" disabled={busy || stopping} onClick={actions.onStop}>
          Stop
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || stopping}
          onClick={actions.onRestart}
        >
          Start over
        </Button>
      </div>
    </>
  );
}

/** "<events> events from <recordings> recordings", or only the recordings when no event is counted, and its verb. */
function keptCounts(kept: NonNullable<RecorderState["kept"]>) {
  const recordings = plural(kept.recordings, "recording", "recordings");
  return kept.events > 0
    ? {
        counts: `${plural(kept.events, "event", "events")} from ${recordings}`,
        verb: kept.events === 1 ? "is" : "are",
      }
    : { counts: recordings, verb: kept.recordings === 1 ? "is" : "are" };
}

function keptSentence(kept: NonNullable<RecorderState["kept"]>): string {
  const { counts, verb } = keptCounts(kept);
  return kept.waitingFor
    ? `${counts} by ${kept.waitingFor.name} ${verb} kept in this browser. Connect this browser to OpenBot again as ${kept.waitingFor.name} to send them.`
    : `${counts} ${verb} kept in this browser: ${stripCaptureStatus(kept.reason)}`;
}

/**
 * After Stop: where to review the recording, what is still sending, and any events kept in the browser. Signed out,
 * only the kept row shows: OpenBot has not heard the stop (nothing to review) and nothing can send.
 */
export function AfterStop({
  state,
  connected,
  openbotUrl,
  onDiscard,
  openTab,
}: {
  state: RecorderState;
  connected: boolean;
  /** The connected OpenBot, for a stopped recording that does not name its own. */
  openbotUrl?: string;
  onDiscard: () => void;
  openTab: (url: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const { lastStopped, kept } = state;
  // Every stopped recording is a drain until it is sent; kept ones wait for a retry, ones kept for a person who
  // signed out send nothing until they connect again (the kept row below says so), and streamed ones only wait for
  // OpenBot, Intelligence having all of them (a pending stop says so in its own sentence).
  const keptRecordings = kept?.recordings ?? 0;
  const streaming = state.draining - (state.streamed ?? 0) > keptRecordings;
  const retrying = keptRecordings > (kept?.waitingFor?.recordings ?? 0);
  const sending = connected && state.draining > 0 && (streaming || retrying);
  // While it is still sending, the Learning capture row below says the same thing.
  const sentence = recordingLearningSentence(
    lastStopped && !sending ? state.learning : undefined,
  );
  const reviewBase = lastStopped?.openbotUrl || openbotUrl;
  // OpenBot has the stop only when connected and it answered: a pending stop has nothing to review yet.
  const reviewUrl =
    connected && !isStopPending(state.error) && lastStopped && reviewBase
      ? `${reviewBase}/bots/${lastStopped.botId}/demonstrations`
      : null;
  if (!kept && !reviewUrl && !sending) return null;
  return (
    <div className="mb-6">
      <PageRows>
        {reviewUrl ? (
          <Item
            size="sm"
            render={
              <a
                href={reviewUrl}
                onClick={(event) => {
                  event.preventDefault();
                  openTab(reviewUrl);
                }}
              />
            }
          >
            <ItemMedia variant="icon">
              <IconCircleCheck />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Saved</ItemTitle>
              <ItemDescription className="line-clamp-none">
                Review it in OpenBot to draft the Skill.
              </ItemDescription>
              {sentence ? (
                <ItemDescription className="line-clamp-none">
                  {sentence}
                </ItemDescription>
              ) : null}
            </ItemContent>
            <ItemActions>
              <IconExternalLink className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        ) : null}
        {sending ? (
          <>
            {reviewUrl ? <Separator /> : null}
            {streaming ? (
              <>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconCloudUpload />
                  </ItemMedia>
                  <ItemContent>
                    <ItemDescription className="line-clamp-none">
                      Sending the last of the recording to Intelligence and
                      OpenBot. You can keep browsing.
                    </ItemDescription>
                  </ItemContent>
                </Item>
                <Separator />
              </>
            ) : null}
            <SendingLearningRow
              kept={retrying ? kept : undefined}
              learning={state.learning}
            />
          </>
        ) : null}
        {kept ? (
          <>
            {reviewUrl || sending ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconDatabaseOff />
              </ItemMedia>
              <ItemContent>
                <ItemDescription className="line-clamp-none">
                  {keptSentence(kept)}
                </ItemDescription>
              </ItemContent>
              <ItemFooter className="justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAsking(true)}
                >
                  Discard kept events
                </Button>
              </ItemFooter>
            </Item>
          </>
        ) : null}
      </PageRows>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard kept events?</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 text-sm">
            Intelligence will never receive them. Your recordings in OpenBot
            stay as they are.
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setAsking(false);
                onDiscard();
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
