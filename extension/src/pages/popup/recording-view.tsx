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
  LearningCaptureRow,
  recordingLearningSentence,
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
  onRecordScreen: () => void;
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
          {state.steps >= 50 && state.noticeShown && !stopping ? (
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
                  <Button size="sm" onClick={() => actions.onNotice("stop")}>
                    Stop
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => actions.onNotice("restart")}
                  >
                    Start over
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
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
      <div className="mt-6">
        <CaptureRows
          capture={state.capture}
          learning={state.learning}
          onRecordScreen={actions.onRecordScreen}
        />
      </div>
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

function keptSentence(kept: NonNullable<RecorderState["kept"]>): string {
  const counts = `${plural(kept.events, "event", "events")} from ${plural(kept.recordings, "recording", "recordings")}`;
  return kept.waitingFor
    ? `${counts} by ${kept.waitingFor.name} are kept in this browser. Connect this browser to OpenBot again as ${kept.waitingFor.name} to send them.`
    : `${counts} ${kept.events === 1 ? "is" : "are"} kept in this browser: ${kept.reason}`;
}

/** After Stop: where to review the recording, what is still sending, and any events kept in the browser. */
export function AfterStop({
  state,
  openbotUrl,
  onDiscard,
  openTab,
}: {
  state: RecorderState;
  openbotUrl: string;
  onDiscard: () => void;
  openTab: (url: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const { lastStopped, kept } = state;
  const draining = state.draining > 0;
  // While it is still sending, the Learning capture row below says the same thing.
  const sentence = recordingLearningSentence(
    lastStopped && !draining ? state.learning : undefined,
  );
  if (!lastStopped && !kept && !draining) return null;
  const reviewUrl = lastStopped
    ? `${lastStopped.openbotUrl || openbotUrl}/bots/${lastStopped.botId}/demonstrations`
    : null;
  return (
    <div className="mb-6">
      <PageRows>
        {lastStopped && reviewUrl ? (
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
                Saved. Review it in OpenBot to draft the Skill.
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
        {draining ? (
          <>
            {lastStopped ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconCloudUpload />
              </ItemMedia>
              <ItemContent>
                <ItemDescription className="line-clamp-none">
                  Sending the last of the recording to Intelligence and OpenBot.
                  You can keep browsing.
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <LearningCaptureRow
              capture={state.capture}
              learning={state.learning}
            />
          </>
        ) : null}
        {kept ? (
          <>
            {lastStopped || draining ? <Separator /> : null}
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
            Discard them? Intelligence will never receive them. Your recordings
            in OpenBot stay as they are.
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
