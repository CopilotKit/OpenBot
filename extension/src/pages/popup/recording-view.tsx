import { joinedLearningContainer } from "@openbot/shared/recorder-api";
import {
  IconCircleCheck,
  IconCloudUpload,
  IconDatabaseOff,
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
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import type { RecorderState } from "../../protocol/messages";
import { KEPT_FOR_PERSON_DAYS } from "../../shared/limits";
import {
  CaptureRows,
  SendingLearningRow,
  stripCaptureStatus,
  type VoiceActions,
  VoiceRow,
} from "../ui/capture-rows";
import { learningSentence } from "./record-form";

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function elapsed(startedAt: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

type RecordingActions = {
  onStop: () => void;
  onRestart: () => void;
  onNotice: (choice: "stop" | "restart" | "continue") => void;
  voice?: VoiceActions;
};

/** What the popup shows while a recording runs: time, actions, the voice, the capture rows, and Stop or Start over. */
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
                    : `${elapsed(state.startedAt, now)} · ${plural(state.actions, "action", "actions")}`}
              </ItemDescription>
            </ItemContent>
          </Item>
          {state.capture.voice ? (
            <>
              <Separator />
              <VoiceRow
                voice={state.capture.voice}
                actions={
                  state.phase === "recording" ? actions.voice : undefined
                }
              />
            </>
          ) : null}
          {/* The service worker says while it is open: any choice, in a tab or here, Stop and Start over close it, and
              its buttons wait while a choice is being sent, as the card stays until the next state says so. */}
          {state.noticeOpen ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemContent>
                  {/* The same words as the notice on the page, which shows once at the threshold. */}
                  <ItemTitle>{`You have recorded ${state.noticeAt ?? state.actions} or more actions`}</ItemTitle>
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
      {/* Kept in view at the bottom of the popup: Chrome caps a popup at 600px, and with the 50-action notice open the
          rows above can run past it. */}
      <div className="sticky bottom-0 -mx-4 -mb-4 mt-6 flex flex-col gap-2 bg-background px-4 pt-3 pb-4">
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
    ? `${counts} by ${kept.waitingFor.name} ${verb} kept in this browser for up to ${KEPT_FOR_PERSON_DAYS} days. Connect this browser to OpenBot again as ${kept.waitingFor.name} to send them.`
    : `${counts} ${verb} kept in this browser: ${stripCaptureStatus(kept.reason)}`;
}

/** Where the stopped recording went in Intelligence: the person's own Learning space, or why Learning will not see it. */
function destinationLines(state: RecorderState): string[] {
  const { lastStopped, learning } = state;
  if (!lastStopped) return [];
  // Into the person's space whenever the capture pass joined it, checked or not.
  const space = !learning
    ? null
    : joinedLearningContainer(learning) !== null
      ? "It goes into your Learning space, and every Bot you use learns from it."
      : learningSentence(learning);
  return space ? [space] : [];
}

/** Which of the after-Stop rows show: sent (Intelligence has all of the last stopped recording) or still sending. */
function afterStopRows(state: RecorderState, connected: boolean) {
  const keptRecordings = state.kept?.recordings ?? 0;
  return {
    keptRecordings,
    streaming: connected && state.draining > keptRecordings,
    sent: connected && state.lastStopped !== undefined && state.draining === 0,
  };
}

/** The Learning sentence the after-Stop row shows about the stopped recording, if any. The Record form under it leaves
 * out the same sentence, so the popup says it once. */
export function afterStopLearningSentence(
  state: RecorderState,
  connected: boolean,
): string | null {
  const { sent, streaming } = afterStopRows(state, connected);
  if (!(sent || streaming) || !state.lastStopped || !state.learning)
    return null;
  return learningSentence(state.learning);
}

/**
 * After Stop: that the recording went to Intelligence (or is still on its way) and into which Learning space, and any
 * events kept in the browser. Signed out, only the kept row shows: nothing can send until the person connects again.
 */
export function AfterStop({
  state,
  connected,
  onDiscard,
}: {
  state: RecorderState;
  connected: boolean;
  onDiscard: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const { kept } = state;
  // Every stopped recording is a drain until Intelligence has all of it; kept ones wait for a retry, and ones kept for
  // a person who signed out send nothing until they connect again (the kept row below says so).
  const { keptRecordings, streaming, sent } = afterStopRows(state, connected);
  const retrying =
    connected && keptRecordings > (kept?.waitingFor?.recordings ?? 0);
  const lines = destinationLines(state);
  if (!kept && !sent && !streaming) return null;
  return (
    <div className="mb-6">
      <PageRows>
        {sent || streaming ? (
          <Item size="sm">
            <ItemMedia variant="icon">
              {sent ? <IconCircleCheck /> : <IconCloudUpload />}
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {sent ? "Sent to Intelligence" : "Sending to Intelligence"}
              </ItemTitle>
              {sent ? null : (
                <ItemDescription className="line-clamp-none">
                  The rest of the recording is on its way. You can keep
                  browsing.
                </ItemDescription>
              )}
              {lines.map((line) => (
                <ItemDescription key={line} className="line-clamp-none">
                  {line}
                </ItemDescription>
              ))}
            </ItemContent>
          </Item>
        ) : null}
        {retrying ? (
          <>
            {sent || streaming ? <Separator /> : null}
            <SendingLearningRow kept={kept} learning={state.learning} />
          </>
        ) : null}
        {kept ? (
          <>
            {sent || streaming || retrying ? <Separator /> : null}
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
            Intelligence will never receive them.
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
