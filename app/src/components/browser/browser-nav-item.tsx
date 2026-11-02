import type { RealBrowser } from "@openbot/shared/openbot-browser";
import type { RecorderActivity } from "@openbot/shared/recorder-api";
import type { RecorderPageState } from "@openbot/shared/recorder-page";
import { IconBrowser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/toast";
import { openBrowserMutationOptions } from "@/lib/browser/mutations";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import {
  CONFIRM_WINDOW_MS,
  canMessageExtensions,
  type RecorderHere,
  type RecorderStore,
  recorderStoreHere,
} from "@/lib/recorder/bridge";
import {
  connectRecorderHereMutationOptions,
  recordHereMutationOptions,
  stopHereMutationOptions,
} from "@/lib/recorder/mutations";
import {
  recorderConnectionsQueryOptions,
  recorderConnectWaitQueryOptions,
  recorderHereQueryOptions,
} from "@/lib/recorder/queries";
import { queryClient } from "@/query-client";
import { NarrationChoiceDialog, useNarrationChoice } from "./narration-choice";
import {
  ConnectHerePanel,
  type ConnectProgress,
  RecordHerePanel,
} from "./recorder-here-popover";
import { elapsed, RecordingMark, useSecondsSince } from "./recording";

const BUTTON_CLASS = "hover:bg-foreground/5 h-10";

/**
 * The sidebar's Browser button, beside Bots, Capabilities and Connections: the person's own browser, with the Recorder
 * in it, in one click.
 *
 * Where OpenBot is open in Chrome or Edge, that browser is the person's own, and the button works with it
 * (`RecorderHere`): with the Recorder in it and connected to this OpenBot, the click opens a popover with Record and
 * Stop, which go to that Recorder; with the Recorder in it but not connected here, the click connects it, as Settings,
 * Browsers does, and the popover follows; with no Recorder in it, the click opens the Recorder's store page there in a
 * new tab (once the Recorder is published in that store).
 *
 * Everywhere else (OpenBot Desktop's own app window, Safari, Firefox), as before. Where the browser is a window on the
 * person's desktop (OpenBot Desktop, `shows: "native"`), the click opens it, or brings it to the front, and leaves the
 * person where they are in OpenBot: they record with the Recorder's own button in that window's toolbar. That window
 * is the person's own everyday Chrome or Edge once the Recorder is in it, and until then, where the Recorder is
 * published, the click opens its store page there for them to add it. Where it is a browser in the page (hosted
 * OpenBot, `shows: "screen"`), the click takes them to the Browser page, which is the browser.
 *
 * While any of the person's Recorders records (`activity`: the OpenBot browser's, or one in their everyday browser, or
 * the one in this browser, read from it directly), the button carries a red dot either way, named for the recording.
 *
 * Drawn only once the server has said OpenBot can run a browser for this person (`available`), and, in Chrome or Edge,
 * once this browser has said whether the Recorder is in it. While either is asked, and when the server cannot be asked,
 * there is no button, rather than one that opens a page saying there is nothing there or changes what it is a moment
 * later.
 */
export function BrowserNavItem() {
  const state = useQuery(browserStateQueryOptions());
  const ids = useRecorderIds();
  const here = useRecorderHere(ids);
  if (state.isPending || !state.data?.available || here === undefined)
    return null;
  const activity = state.data.activity;
  // Elsewhere, as before. A server from before `shows` only had the Browser page, so it keeps leading there.
  return (
    <SidebarMenuItem>
      {here.kind === "connected" || here.kind === "unconnected" ? (
        <RecorderHereButton activity={activity} here={here} ids={ids ?? []} />
      ) : here.kind === "absent" ? (
        <StorePageLink activity={activity} store={here.store} url={here.page} />
      ) : state.data.shows === "native" ? (
        <OpenWindowButton activity={activity} />
      ) : (
        <BrowserPageLink activity={activity} />
      )}
    </SidebarMenuItem>
  );
}

const UNREACHABLE: RecorderHere = { kind: "unreachable" };

/**
 * Whether this page is somewhere the Recorder could be: it can message an extension now, or it is in Chrome or Edge on a
 * computer, where adding the Recorder gives the page that at once. Read at every render, because adding the Recorder
 * changes the first while the page is open.
 */
function mayHoldRecorder(): boolean {
  return canMessageExtensions() || recorderStoreHere() !== null;
}

/**
 * The Recorder ids this OpenBot trusts, from the server, as Settings, Browsers asks for them: `undefined` while asked,
 * and `null` where the Recorder cannot be (no ids are asked for), or the server could not say. They are OpenBot's
 * configuration, so they are not asked again each time the person comes back to the tab.
 */
function useRecorderIds(): readonly string[] | null | undefined {
  const mayHold = mayHoldRecorder();
  const connections = useQuery({
    ...recorderConnectionsQueryOptions(),
    enabled: mayHold,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!mayHold || connections.isError) return null;
  return connections.data?.extensionIds;
}

/**
 * The Recorder in the browser OpenBot is open in: `undefined` while this browser is asked, and `unreachable` where
 * OpenBot cannot work with it, so the button is what it was before.
 */
function useRecorderHere(
  ids: readonly string[] | null | undefined,
): RecorderHere | undefined {
  const here = useQuery({
    ...recorderHereQueryOptions(ids ?? []),
    enabled: !!ids,
  });
  if (ids === null) return UNREACHABLE;
  return here.data;
}

/** The one toast a refused open says itself in. */
const REFUSED_TOAST = "browser-open-refused";
/** The one toast that says the Recorder's store page opened. */
const STORE_TOAST = "browser-store-opened";

const REAL_BROWSER_NAMES: Record<RealBrowser, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
};

/**
 * What the person is told when the click opened the Recorder's page in the store of their own browser, rather than a
 * browser with the Recorder in it: the page is there, in the browser named, and adding it is what lets them record in
 * that browser. Once it is added and connected, the same click brings that browser forward.
 */
export function storeOpenedSentence(browser: RealBrowser): string {
  return `The OpenBot Recorder's page is open in ${REAL_BROWSER_NAMES[browser]}. Add it there to record in your own browser.`;
}

/**
 * A button, not a link: it does something and goes nowhere. While the browser is opening it says so and takes no
 * further click, and when the server refuses, its sentence is a toast, because the person stays wherever they were in
 * OpenBot and the button has no page of its own to say it on.
 *
 * Unless what opened is a browser in the page after all (`window: "screen"`): OpenBot Desktop opens one where it finds
 * no Chrome or Edge to use. Its window is the Browser page, so the click takes the person there, as a hosted OpenBot's
 * button does; left where they were, they saw "Opening…" and then nothing, with the browser open on a page they could
 * not see.
 *
 * Opening is busy (`aria-busy`), not disabled: the click handler ignores a click while it opens, and the row keeps its
 * full contrast and the keyboard's focus. The sidebar draws `aria-disabled` at half opacity, and the seventh end-to-end
 * run found "Opening…" too faint to read that way.
 *
 * The refusal stays until the person closes it, as every error toast does (components/ui/toast.tsx), and goes once an
 * open succeeds, because it is no longer true. A click that opened the Recorder's store page in the person's own
 * browser says so in a short note of its own, because nothing else in OpenBot changes to show it.
 */
function OpenWindowButton({ activity }: { activity?: RecorderActivity }) {
  const open = useMutation(openBrowserMutationOptions(queryClient));
  const navigate = useNavigate();
  const recording = useRecordingLabel(activity);
  const opening = open.isPending;
  return (
    <SidebarMenuButton
      aria-busy={opening || undefined}
      className={BUTTON_CLASS}
      onClick={() => {
        if (open.isPending) return;
        open.mutate(undefined, {
          onSuccess: (answer) => {
            toast.close(REFUSED_TOAST);
            if ("window" in answer && answer.window === "screen") {
              void navigate({ to: "/browser" });
              return;
            }
            if ("opened" in answer && answer.opened === "store")
              toast.add({
                // One at a time: a second click replaces the note rather than stacking another under it.
                id: STORE_TOAST,
                title: storeOpenedSentence(answer.browser),
                type: "info",
              });
          },
          onError: (error) =>
            toast.add({
              // One at a time: a second refusal replaces the first rather than stacking under it.
              id: REFUSED_TOAST,
              title: error.message,
              type: "error",
              priority: "high",
            }),
        });
      }}
      tooltip={recordingTooltip(recording)}
    >
      <BrowserLabel>
        {opening ? (
          <span className="ml-auto text-xs text-muted-foreground">
            Opening…
          </span>
        ) : recording ? (
          <RecordingDot {...recording} />
        ) : null}
      </BrowserLabel>
    </SidebarMenuButton>
  );
}

const STORE_NAMES: Record<RecorderStore, string> = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
};

/**
 * What the person is told when the click opened the Recorder's store page in a new tab of the browser OpenBot is open
 * in: adding it there is what lets them record from here. Once it is added, the same click connects it.
 */
export function storeTabSentence(store: RecorderStore): string {
  return `The OpenBot Recorder's page is open in a new tab. Add it to ${STORE_NAMES[store]} to record from OpenBot.`;
}

/** The short note that waits in OpenBot for a person who opened the Recorder's store page in a new tab: one at a time,
 * so a second click replaces it rather than stacking another under it. Settings, Browsers says the same. */
export function noteStoreTabOpened(store: RecorderStore): void {
  toast.add({ id: STORE_TOAST, title: storeTabSentence(store), type: "info" });
}

/**
 * Chrome or Edge with no Recorder in it: a link to the Recorder's store page there, in a new tab, because it goes
 * somewhere (a link opens it from the keyboard as from the mouse, and no popup blocker stops it). The new tab takes the
 * person's attention, so a short note waits in OpenBot for when they come back.
 */
function StorePageLink({
  activity,
  store,
  url,
}: {
  activity?: RecorderActivity;
  store: RecorderStore;
  url: string;
}) {
  const recording = useRecordingLabel(activity);
  return (
    <SidebarMenuButton
      className={BUTTON_CLASS}
      render={
        <a
          href={url}
          onClick={() => noteStoreTabOpened(store)}
          rel="noopener noreferrer"
          target="_blank"
        />
      }
      tooltip={recordingTooltip(recording)}
    >
      <BrowserLabel>
        {recording ? <RecordingDot {...recording} /> : null}
      </BrowserLabel>
    </SidebarMenuButton>
  );
}

type ConnectedState = Extract<RecorderPageState, { connected: true }>;

/**
 * What the red dot follows while the Recorder in this browser is connected here: its own report when it records, read
 * from it directly so the dot is there at once; otherwise the server's `activity`, which covers the person's other
 * Recorders. Except a recording this Recorder has already stopped, which the server may not have heard of yet.
 */
function dotFrom(
  local: ConnectedState | undefined,
  activity: RecorderActivity | undefined,
): RecorderActivity | undefined {
  if (local && local.phase !== "idle") return local;
  if (
    activity?.recordingId !== undefined &&
    activity.recordingId === local?.lastStopped?.recordingId
  )
    return undefined;
  return activity;
}

/**
 * Where a connect the click started has got to, from its mutation, while the Recorder does not yet say it is connected:
 * null when none is under way, or when one finished with no Connect page to wait for (a trusted OpenBot, connected at
 * once: the mutation is pending until the Recorder has been asked again, so by then it says connected).
 */
function connectProgress(
  connect: {
    isPending: boolean;
    error: Error | null;
    data?: { awaitingConfirmation: boolean };
  },
  expired: boolean,
): ConnectProgress | null {
  if (connect.isPending) return { state: "sending" };
  if (connect.error) return { state: "failed", message: connect.error.message };
  if (!connect.data?.awaitingConfirmation) return null;
  return expired ? { state: "expired" } : { state: "awaiting" };
}

/**
 * The Recorder in the browser OpenBot is open in, in a popover from the Browser button. Connected to this OpenBot:
 * Record and Stop, through `openbot.record` and `openbot.stop`. Not connected here: the click that opens the popover
 * connects it, as Settings, Browsers does, and the popover says how that goes until the Recorder answers connected,
 * when it shows Record. A trusted OpenBot (the organization's own, or OpenBot Desktop) is connected at once; anywhere
 * else the Recorder shows its Connect page, and the person confirms there.
 *
 * Base UI makes the button the popover's trigger (`aria-expanded`, `aria-haspopup`), moves focus into the popover as it
 * opens and back to the button as it closes, and closes it on Escape or a press outside.
 */
function RecorderHereButton({
  activity,
  here,
  ids,
}: {
  activity?: RecorderActivity;
  here: Extract<RecorderHere, { kind: "connected" | "unconnected" }>;
  ids: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const connect = useMutation(connectRecorderHereMutationOptions(queryClient));
  const record = useMutation(recordHereMutationOptions(queryClient));
  const stop = useMutation(stopHereMutationOptions(queryClient));
  /*
   * The person's narration choice, kept on their account, goes with Record as OpenBot's own Record form passes it on, so
   * the Recorder opens a microphone only for a person who chose to narrate. One who never chose is asked first, by the
   * same question, and `asking` holds the task they named meanwhile.
   */
  const choice = useNarrationChoice();
  const [asking, setAsking] = useState<string | null>(null);
  const recordHere = (title: string, narrate: boolean | undefined) =>
    record.mutate({
      id: here.id,
      title,
      ...(narrate !== undefined ? { narrate } : {}),
    });
  const [expired, setExpired] = useState(false);
  // The person pressed Cancel on the Recorder's Connect page, or closed it, as the Recorder said when asked.
  const [ended, setEnded] = useState<"cancelled" | "closed" | null>(null);
  const connected = here.kind === "connected";
  const progress = connected
    ? null
    : ended
      ? { state: ended }
      : connectProgress(connect, expired);
  const awaiting = progress?.state === "awaiting";
  // Asked every 2 s while the person confirms the connect in the Recorder's own tab, as Settings, Browsers asks.
  useQuery({
    ...recorderHereQueryOptions(ids, { awaiting }),
    enabled: awaiting,
  });
  // And where that connect has got to there, so a Cancel or the tab closed ends the wait at once, with Connect back.
  const wait = useQuery({
    ...recorderConnectWaitQueryOptions(here.id, connect.submittedAt),
    enabled: awaiting,
  });
  useEffect(() => {
    if (awaiting && (wait.data === "cancelled" || wait.data === "closed"))
      setEnded(wait.data);
  }, [awaiting, wait.data]);

  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(() => setExpired(true), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [awaiting]);

  // Connected: the connect is over, and a later one (after a Disconnect) starts afresh.
  const { reset } = connect;
  useEffect(() => {
    if (!connected) return;
    reset();
    setExpired(false);
    setEnded(null);
  }, [connected, reset]);

  function startConnect() {
    setExpired(false);
    setEnded(null);
    connect.mutate(here.id);
  }

  const recording = useRecordingLabel(
    dotFrom(connected ? here.state : undefined, activity),
  );
  return (
    <>
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          // The click that opens it connects the Recorder, unless a connect is already under way or has said why not.
          if (next && !connected && progress === null) startConnect();
          // A refusal is about the last Record or Stop; the next time the popover opens it starts clean.
          if (!next) {
            record.reset();
            stop.reset();
          }
        }}
        open={open}
      >
        <PopoverTrigger
          render={
            <SidebarMenuButton
              className={BUTTON_CLASS}
              tooltip={recordingTooltip(recording)}
            />
          }
        >
          <BrowserLabel>
            {recording ? <RecordingDot {...recording} /> : null}
          </BrowserLabel>
        </PopoverTrigger>
        {/* Above the button and as wide as it, as the account menu below it opens; never narrower than a task name
         * needs, which a collapsed sidebar's icon would make it. */}
        <PopoverContent
          align="start"
          className="w-(--anchor-width) min-w-72"
          side="top"
          sideOffset={8}
        >
          {connected ? (
            <RecordHerePanel
              controls={{
                record: async (title) => {
                  stop.reset();
                  const narration = await choice.read();
                  if (narration === null) {
                    setAsking(title);
                    return;
                  }
                  // Not readable: the Recorder's own choice, with no microphone until the person made one there.
                  recordHere(
                    title,
                    narration === undefined ? undefined : narration === "on",
                  );
                },
                recordPending: record.isPending,
                stop: () => {
                  record.reset();
                  stop.mutate(here.id);
                },
                stopPending: stop.isPending,
                error: record.error ?? stop.error,
              }}
              state={here.state}
            />
          ) : (
            <ConnectHerePanel
              connect={startConnect}
              progress={progress ?? { state: "idle" }}
            />
          )}
        </PopoverContent>
      </Popover>
      <NarrationChoiceDialog
        onAnswer={(narrate) => {
          const title = asking;
          setAsking(null);
          choice.choose(narrate);
          if (title) recordHere(title, narrate);
        }}
        onClose={() => setAsking(null)}
        open={asking !== null}
      />
    </>
  );
}

/** A link, as it has always been: the Browser page is where a browser in the page is. */
function BrowserPageLink({ activity }: { activity?: RecorderActivity }) {
  const recording = useRecordingLabel(activity);
  return (
    <SidebarMenuButton
      className={BUTTON_CLASS}
      render={(props) => (
        <Link
          {...props}
          to="/browser"
          activeProps={{ className: "bg-foreground/5" }}
        />
      )}
      tooltip={recordingTooltip(recording)}
    >
      <BrowserLabel>
        {recording ? <RecordingDot {...recording} /> : null}
      </BrowserLabel>
    </SidebarMenuButton>
  );
}

/** The icon and the name every item in this part of the sidebar has, and what goes at the end of the row. */
function BrowserLabel({ children }: { children?: ReactNode }) {
  return (
    <>
      <div className="size-[28px] flex items-center justify-center">
        <IconBrowser />
      </div>
      <span className="text-sm">Browser</span>
      {children}
    </>
  );
}

type RecordingLabel = { label: string; live: boolean };

/**
 * What the recording running in one of the person's browsers is called on the Browser button, from its Recorder's own
 * report as the server passes it on: "Recording: Submit the receipt, 1:23", ticking while it runs. Null while nothing is
 * being recorded. `live` while it records, rather than starting or stopping, as the Browser page's own mark has it.
 */
function useRecordingLabel(
  activity: RecorderActivity | undefined,
): RecordingLabel | null {
  const phase = activity?.phase ?? "idle";
  const seconds = useSecondsSince(
    phase === "recording" ? activity?.startedAt : undefined,
  );
  if (!activity || phase === "idle") return null;
  const named = activity.title ? `Recording: ${activity.title}` : "Recording";
  const progress =
    phase === "starting"
      ? "starting"
      : phase === "stopping"
        ? "stopping"
        : activity.startedAt === undefined
          ? null
          : elapsed(seconds);
  return {
    label: progress ? `${named}, ${progress}` : named,
    live: phase === "recording",
  };
}

/**
 * The tooltip naming the recording, shown beside the button whether or not the sidebar is collapsed. Always given, and
 * hidden while nothing records, so the button is never remounted (and never loses the keyboard's focus) as a recording
 * starts and stops.
 */
function recordingTooltip(recording: RecordingLabel | null) {
  return {
    children: recording?.label ?? "Browser",
    hidden: recording === null,
  };
}

/** The recording's red dot at the end of the row, named as the tooltip names it (Base UI's tooltip is never read out). */
function RecordingDot({ label, live }: RecordingLabel) {
  return (
    <span aria-label={label} className="ml-auto" role="img">
      <RecordingMark live={live} />
    </span>
  );
}
