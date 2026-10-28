import type { BotBrowserApiState } from "@openbot/shared/bot-browser";
import { IconLock, IconPlayerStop } from "@tabler/icons-react";
import { RECORDER_COLLECTS_SHORT } from "@openbot/shared/recorder-disclosure";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useId } from "react";
import {
  AddressBar,
  ClearBrowserDialog,
  latest,
  shownAddress,
  TabPanel,
  TabStrip,
  useClearBrowserData,
  useOpenedTab,
} from "@/components/browser/browser-bar";
import { NarrationRow } from "@/components/browser/narration";
import {
  type NarrationChoice,
  NarrationChoiceDialog,
  useNarrationChoice,
} from "@/components/browser/narration-choice";
import {
  narrationLanguage,
  RecordingMark,
  RecordingRow,
  StoppedRow,
  useRecordingWith,
} from "@/components/browser/recording";
import { useNarration } from "@/components/browser/use-narration";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useComputerControl } from "@/lib/computers/use-control";
import {
  botBrowserTabsMutationOptions,
  clearBotBrowserMutationOptions,
  navigateBotBrowserMutationOptions,
  sendBotBrowserNarration,
  startBotBrowserRecordingMutationOptions,
  stopBotBrowserRecordingMutationOptions,
} from "@/lib/bot-browser/mutations";
import { queryClient } from "@/query-client";

/*
 * A BOT'S BROWSER, WORKED BY A PERSON (`shared/bot-browser.ts`): the bar above the Bot's screen, and Record under it.
 *
 * Both are the person's own browser's, shared rather than copied (`components/browser`), so a Bot's browser reads as
 * the same browser the Browser page shows. What differs is the wheel: the bar and Record act only for the person who
 * holds it (`mine`, the server's verdict), and only that person is ever recorded.
 */

/**
 * Tabs, back, forward, reload and the address, above the Bot's screen (`children`), which is the tabs' panel with the
 * address. Live for the person holding the wheel; while the Bot (or someone else) holds it, it shows where the Bot is,
 * and nothing in it acts.
 *
 * Until the Bot's browser has first answered (`state` undefined) there is no bar, only the screen: and the screen keeps
 * its place in the tree when the bar arrives, so its live stream is not opened a second time.
 *
 * `onNavigated` is told when an address typed in the bar goes, so the keyboard can go back to the page, as Chrome's
 * address bar gives it to the page it opens (the person's own browser does the same, browser-screen.tsx).
 */
export function BotBrowserBar({
  botId,
  state,
  onNavigated,
  children,
}: {
  botId: string;
  state: BotBrowserApiState | undefined;
  onNavigated?: () => void;
  children: ReactNode;
}) {
  const tabs = useMutation(botBrowserTabsMutationOptions(queryClient, botId));
  const navigate = useMutation(
    navigateBotBrowserMutationOptions(queryClient, botId),
  );
  const clear = useMutation(clearBotBrowserMutationOptions(queryClient, botId));
  const clearing = useClearBrowserData(clear);
  const ids = useId();
  const active = state?.tabs.find((tab) => tab.active);
  const newTab = useOpenedTab(active?.id);
  const live = state ? state.mine && state.open : false;
  // A refusal belongs to the person who asked while they could. Once the wheel has gone, the bar is the Bot's and the
  // sentence about the person's last request is not news.
  const failure = live
    ? latest([
        { error: tabs.error, at: tabs.submittedAt },
        { error: navigate.error, at: navigate.submittedAt },
      ])
    : null;
  return (
    <>
      {state ? (
        <TabStrip
          ids={ids}
          tabs={state.tabs}
          disabled={!live}
          onActivate={(tabId) => tabs.mutate({ action: "activate", tabId })}
          onClose={(tabId, closed) =>
            tabs.mutate(
              { action: "close", tabId },
              closed ? { onSuccess: closed } : undefined,
            )
          }
          onNew={() =>
            tabs.mutate({ action: "new" }, { onSuccess: newTab.opened })
          }
        />
      ) : null}
      {/* Not min-h-0: the screen inside keeps its floor, and the window grows past it rather than clip it. */}
      <TabPanel
        active={active}
        className="flex flex-1 flex-col"
        ids={ids}
        tabs={state !== undefined}
      >
        {state ? (
          <AddressBar
            // A new tab, switching to one, or the wheel changing hands starts the bar again from the tab's own address:
            // an address half typed before the wheel went is not where the browser is when it comes back.
            key={`${active?.id ?? "none"}:${state.mine}`}
            address={shownAddress(active)}
            disabled={!state.open || !active}
            readOnly={!state.mine}
            focus={newTab.focus}
            onFocused={newTab.onFocused}
            onGo={(url) => {
              navigate.mutate({ url });
              // Away to the page, as Chrome's address bar does: the next keys are for the page that opens.
              onNavigated?.();
            }}
            onMove={(action) => navigate.mutate({ action })}
            // Only for the person holding the wheel, so the browser is never wiped under the Bot. Open or closed: its
            // data is there either way, and a running recording of theirs is ended by the clear itself.
            clear={{ disabled: !state.mine, ask: clearing.ask }}
          />
        ) : null}
        {failure ? (
          <p
            className="border-b border-border px-3 py-2 text-destructive text-sm"
            role="alert"
          >
            {failure.message}
          </p>
        ) : null}
        {children}
      </TabPanel>
      {/* Over the Bot's screen, which is a dialog itself. */}
      <ClearBrowserDialog
        clear={clear}
        open={clearing.asking}
        onOpenChange={clearing.setAsking}
        stacked
      />
    </>
  );
}

/**
 * THE PERSON'S RECORDINGS IN A BOT'S BROWSER, as this page saw them run, kept outside any component so closing and
 * opening the Bot's screen again does not forget them.
 *
 * Not who a recording belonged to: the computer says that (`lastStoppedBy`), so a reload says the same. What only this
 * page knows is how one it saw running ended: Stop pressed here, or the computer ending it as the wheel left the person,
 * which the panel says in so many words. One this page never saw running is reported plainly.
 */
type MyRecording = {
  title: string;
  /** Whether the person pressed Stop on it here, rather than the computer ending it as the wheel left them. */
  stoppedHere: boolean;
};
const MY_RECORDINGS = new Map<string, MyRecording>();
/** Per Bot: the person's recording seen running last, until a report names it or another recording starts. */
const LAST_SEEN_RUNNING = new Map<string, string>();
const recordingKey = (botId: string, recordingId: string) =>
  `${botId}\n${recordingId}`;

/** What the panel says when a recording of the person's ended without Stop, while they no longer hold the wheel. */
const ENDED_WITH_THE_WHEEL =
  "The recording ended when control went back to the Bot.";

/**
 * Record and Stop for the Bot's browser, for the person holding the wheel, from the Recorder's report and the server's
 * verdicts in `state`. Narration goes to the Bot's browser's own route.
 */
function useBotRecording(
  botId: string,
  state: BotBrowserApiState,
  choice: NarrationChoice,
  hooks: {
    beforeStop: () => Promise<void>;
    answered: (narrate: boolean) => void;
  },
) {
  const recorder = state.recorder;
  const running = recorder !== undefined && recorder.phase !== "idle";
  const runningId =
    running && state.recordingIsMine ? recorder.recordingId : undefined;
  /*
   * Written during render, as the computer view keeps the turns it has seen: idempotent, and it has to be in hand in
   * the same render that reads it, or the render after a recording ends would not know it was the person's.
   */
  if (runningId) {
    const key = recordingKey(botId, runningId);
    MY_RECORDINGS.set(key, {
      title: recorder?.title ?? "",
      stoppedHere: MY_RECORDINGS.get(key)?.stoppedHere ?? false,
    });
    LAST_SEEN_RUNNING.set(botId, runningId);
  } else if (running) {
    // Someone else's recording: whatever the person's last one was, this is newer.
    LAST_SEEN_RUNNING.delete(botId);
  }

  // The same store the wheel's own button reads, so this says what the row above it says.
  const { someoneElse } = useComputerControl(botId);
  const recording = useRecordingWith({
    recorder,
    waiting: !state.mine
      ? someoneElse
        ? "Someone else has control."
        : "Take control to record."
      : !state.open
        ? "The Bot's browser isn't open."
        : null,
    start: startBotBrowserRecordingMutationOptions(queryClient, botId),
    stop: stopBotBrowserRecordingMutationOptions(queryClient, botId),
    choice,
    ...hooks,
  });

  const last = recording.stopped;
  /*
   * The person's own, by the computer's word, and never a guess: a person not known yet is told nothing rather than
   * told another person's recording went to their Learning space.
   */
  const me = useQuery(currentUserQueryOptions()).data?.id;
  const mine =
    last !== undefined && me !== undefined && state.lastStoppedBy === me;
  const seenEnding = last
    ? MY_RECORDINGS.get(recordingKey(botId, last.recordingId))
    : undefined;
  if (last && LAST_SEEN_RUNNING.get(botId) === last.recordingId)
    LAST_SEEN_RUNNING.delete(botId);
  const seen = running ? undefined : LAST_SEEN_RUNNING.get(botId);
  /**
   * A recording of the person's that ended with no report of it: the Bot's browser restarted under it, and the
   * Recorder that reports now never saw it. It still ended, which is what the person is told.
   */
  const unreported = seen
    ? MY_RECORDINGS.get(recordingKey(botId, seen))
    : undefined;

  return {
    ...recording,
    /** Another person's recording is running: the panel says only that someone is recording. */
    theirs: running && !state.recordingIsMine,
    /** The person's recording Stop ended last, or the computer did as the wheel left them, with what it held. */
    stopped: mine ? last : undefined,
    /** The computer ended it as the wheel left them, while this page watched it run. */
    endedWithoutStop: seenEnding ? !seenEnding.stoppedHere : false,
    unreported,
    /*
     * A Stop the server refused once the recording had already ended (the wheel went back as it was pressed) is not
     * a failure: the panel says the recording ended. Only a refusal while it is still running is shown.
     */
    error:
      recording.startError ?? (runningId ? recording.stopError : null) ?? null,
    async stop() {
      if (runningId) {
        const key = recordingKey(botId, runningId);
        const known = MY_RECORDINGS.get(key);
        if (known) MY_RECORDINGS.set(key, { ...known, stoppedHere: true });
      }
      await recording.stop();
    },
  };
}

/**
 * Record under the Bot's screen: name the task, Record, do it, Stop. Only while the person holds the wheel, so only
 * they are recorded, never the Bot; the recording goes to their own Learning space, as the Recorder's do from any
 * browser.
 *
 * Narration is the person's own choice, the one their account keeps for every browser they record in (the Browser page
 * asks the same question and reads the same answer): asked before their first recording, the microphone closed until
 * they say yes, and their speech turned into text on their own computer.
 */
export function BotRecordPanel(props: {
  botId: string;
  state: BotBrowserApiState;
}) {
  // Where the Bots share one computer, so another Bot could read the person's Recorder connection off the disk.
  if (props.state.recordRefused)
    return (
      <section aria-label="Record a task">
        <h2 className="font-semibold text-sm">Record a task</h2>
        <PageRows className="mt-3">
          <Item size="sm" role="status">
            <ItemMedia variant="icon">
              <IconLock className="text-muted-foreground" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Recording isn't available here</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {props.state.recordRefused}
              </ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
      </section>
    );
  return <RecordPanel {...props} />;
}

function RecordPanel({
  botId,
  state,
}: {
  botId: string;
  state: BotBrowserApiState;
}) {
  const language = narrationLanguage();
  const listening =
    state.recordingIsMine && state.recorder?.phase === "recording";
  const choice = useNarrationChoice();
  const narration = useNarration({
    listening,
    language,
    chosen: choice.narration === "on",
    send: (post) => sendBotBrowserNarration(botId, post),
  });
  const recording = useBotRecording(botId, state, choice, {
    beforeStop: narration.finish,
    // A yes on the narration question is the person's click: narration turns on with it, asking the browser for its
    // speech recognition on their computer while the click still counts.
    answered: (narrate) => {
      if (narrate) narration.setOn(true);
    },
  });
  /** Why a recording of the person's ended that Stop did not end: the wheel going back, as a rule. */
  const ended = state.mine ? "The recording ended." : ENDED_WITH_THE_WHEEL;
  return (
    <section aria-label="Record a task">
      <h2 className="font-semibold text-sm">Record a task</h2>
      <p className="mt-1 text-pretty text-muted-foreground text-sm">
        Do the task in the Bot's browser while you have control. Only what you
        do is recorded, and it goes to your own Learning space.{" "}
        {RECORDER_COLLECTS_SHORT}
      </p>
      <PageRows className="mt-3">
        {recording.theirs ? (
          <Item size="sm">
            <ItemMedia variant="icon">
              <RecordingMark live={false} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Someone is recording</ItemTitle>
              <ItemDescription>You can record once they stop.</ItemDescription>
            </ItemContent>
          </Item>
        ) : (
          <RecordingRow
            recording={recording}
            placeholder="Name the task to record"
          />
        )}
        {/* Narration is for the person who can record: their own microphone, while they hold the wheel. */}
        {state.mine && !recording.theirs ? (
          <>
            <Separator />
            <NarrationRow
              narration={narration}
              choice={choice.narration}
              language={language}
              recording={listening}
              onChange={(on) => {
                narration.setOn(on);
                choice.choose(on);
              }}
            />
          </>
        ) : null}
        {recording.unreported ? (
          <>
            <Separator />
            <Item size="sm" role="status">
              <ItemMedia variant="icon">
                <IconPlayerStop className="text-muted-foreground" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{recording.unreported.title}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {ended}
                </ItemDescription>
              </ItemContent>
            </Item>
          </>
        ) : recording.stopped ? (
          <>
            <Separator />
            <StoppedRow
              stopped={recording.stopped}
              ended={recording.endedWithoutStop ? ended : undefined}
            />
          </>
        ) : null}
      </PageRows>
      {recording.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {recording.error.message}
        </p>
      ) : null}
      <NarrationChoiceDialog {...recording.question} />
    </section>
  );
}
