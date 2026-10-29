import type { BotBrowserApiState } from "@openbot/shared/bot-browser";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  botBrowserKeys,
  botBrowserStateQueryOptions,
} from "@/lib/bot-browser/queries";
import { botsReason, supplySecret } from "@/lib/computers/control";
import {
  type ComputerState,
  computerStatusQueryOptions,
} from "@/lib/computers/queries";
import {
  readPageFrame,
  readScreenshot,
  type Screenshot,
} from "@/lib/computers/screen";
import { useComputerControl } from "@/lib/computers/use-control";
import { queryClient } from "@/query-client";
import { ChannelAvatar } from "../channels/avatar";
import { BotBrowserBar, BotRecordPanel } from "./bot-browser";
import { ComputerControlButton } from "./computer-controls";
import { LiveScreen, type LiveScreenHandle } from "./live-screen";
import { useElementVisible, usePageVisible } from "./preview-visibility";

/** Explicit blank-browser URLs use placeholder artwork; missing URL fields are treated as real pages. */
function isBlankBrowser(shot: Screenshot): boolean {
  if (shot.url === undefined) return false;
  const url = shot.url.trim();
  return url === "" || url === "about:blank";
}

/** The part of a URL worth putting on screen; the whole thing is rarely readable at this size. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What each finished turn opened, and the frame it ended on, kept outside any component.
 *
 * MODULE SCOPE, BECAUSE THE TILE DOES NOT SURVIVE. A transcript re-renders freely and remounts the
 * tiles in it, and anything held in component state goes with it: the fresh mount has no page yet,
 * behaves for one render like a live turn, and reaches for the live screen. Keyed on the tool call,
 * which is the identity of the turn rather than of the component drawing it.
 *
 * Bounded, because a long conversation is a lot of screenshots. Oldest out first, and a turn whose
 * frame has been dropped falls back to naming its page.
 */
type RememberedTurn = {
  page?: { url?: string; title?: string };
  frame?: { base64: string; url: string };
  /** Whether the server has already been asked, so a turn with no frame is not asked again. */
  asked?: boolean;
};
const REMEMBERED_TURNS = new Map<string, RememberedTurn>();
const MAX_REMEMBERED_TURNS = 40;

function rememberTurn(toolCallId: string, patch: RememberedTurn): void {
  const existing = REMEMBERED_TURNS.get(toolCallId) ?? {};
  /*
   * A FRAME IS WRITTEN ONCE, which is what the server's own insert says and what this has to agree
   * with. Letting a later write win is exactly what went wrong: the tile restored the right frame and
   * then replaced it, one render later, with a screenshot of whatever the Bot had open by then.
   */
  const merged: RememberedTurn = { ...existing, ...patch };
  if (existing.frame) merged.frame = existing.frame;
  REMEMBERED_TURNS.delete(toolCallId);
  REMEMBERED_TURNS.set(toolCallId, merged);
  while (REMEMBERED_TURNS.size > MAX_REMEMBERED_TURNS) {
    const oldest = REMEMBERED_TURNS.keys().next().value;
    if (oldest === undefined) break;
    REMEMBERED_TURNS.delete(oldest);
  }
}

/** Default browser viewport ratio, reserved before the first screenshot arrives. */
const DEFAULT_ASPECT_RATIO = 1280 / 800;

/** Minimum readable inline screen size. */
const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 200;

/** Preload without failing the poll loop when a frame cannot be decoded early. */
async function preloadFrame(base64: string): Promise<void> {
  try {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
  } catch {
    // Let the visible image element handle decode failures.
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * How long a computer may go without a frame before that is worth telling anybody.
 *
 * GENEROUS ON PURPOSE. A first start pulls an image, schedules a pod and launches a browser, and a
 * minute is ordinary. The panel used to call the first frameless poll a problem, so every cold start
 * opened on "Can't show the screen right now… ask an admin", in front of a person whose computer was
 * doing exactly what it should. Past the server's own wait for a cold start, with room to spare.
 */
const STARTUP_GRACE_MS = 150_000;

/** How often a computer that has not drawn a frame yet is asked where it is. */
const STATUS_POLL_MS = 2_000;

/** Identical frames in a row that mean the page has stopped changing. */
const SETTLED_FRAMES = 3;

/** Hard cap for post-action polling on pages that never settle. */
const SETTLE_TIMEOUT_MS = 30_000;

/** Short confirmation window after a secret is sent to the page. */
const SECRET_CONFIRM_MS = 6_000;

/**
 * What the frame says when there is no picture in it.
 *
 * Shared by the card and the full-size view because it is the same fact at either size, and because
 * the full-size view is now reachable with nothing to draw: the wheel lives down there, so a person
 * whose Bot is looking at a blank browser — or whose screen cannot be read at all — has to be able
 * to open it and be told why it is empty, rather than find a disabled frame and no way in.
 */
function NothingToSee({
  problem,
  blankBrowser,
  settled,
  page,
  waiting,
  owner = "the Bot's",
}: {
  problem: string | null;
  blankBrowser: boolean;
  /**
   * Why there is no picture yet, when the reason is ordinary.
   *
   * `starting` is a computer on its way up, which on a first start takes about a minute; `asleep` is
   * one that is off and starts on the Bot's next action. Neither is a problem and neither is drawn as
   * one. A problem is only what is left after a generous wait, or a computer the server says it
   * cannot reach.
   */
  waiting?: "starting" | "asleep" | undefined;
  /** Whose computer, possessive and lower case: "Sales's", or "the Bot's" without a name. */
  owner?: string;
  /** Whether this is a turn that has finished, rather than the browser as it is now. */
  settled?: boolean;
  /** The page that turn opened, named when there is no picture of it. */
  page?: { url?: string; title?: string } | undefined;
}) {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-muted-foreground text-sm">
      {settled ? (
        <>
          {/*
            What this turn had open, named rather than drawn.

            The picture is gone: nothing stored it, and fetching one now would show a different page.
            Naming the page is the honest version of the same sentence, and it stays true however
            many times the Bot has browsed since.

            GATED ON THE TURN BEING OVER, not on whether a live frame happens to be in hand. A tile
            that was live a moment ago keeps its last screenshot in state after it settles, and this
            used to check for that: with one held and no frame stored, it fell through to "Waiting
            for the assistant's screen…" and waited there for ever, because the poll that would have
            ended the wait stops the moment a turn settles.
          */}
          {page?.url ? (
            <>
              <span className="font-medium">{page.title || "A page"}</span>
              <span className="break-all">{hostOf(page.url)}</span>
              <span>
                Opened during this turn. The screen has moved on since.
              </span>
            </>
          ) : (
            /*
             * A turn that ended without getting anywhere: refused by a boundary, stopped, or failed.
             * Saying "opened during this turn" here would describe something that did not happen.
             */
            <span>This turn did not open a page.</span>
          )}
        </>
      ) : problem ? (
        <>
          <span className="font-medium">Can't show the screen right now</span>
          <span>{problem}</span>
          <span>
            The Bot may still be working. If this keeps happening, ask an admin
            to check its Computer.
          </span>
        </>
      ) : waiting === "starting" ? (
        <span role="status">
          Starting {owner} computer. The first start takes about a minute.
        </span>
      ) : waiting === "asleep" ? (
        <span role="status">
          {capitalise(owner)} computer is off. It starts when the Bot next uses
          it.
        </span>
      ) : blankBrowser ? (
        <span>The Bot hasn't opened a page yet.</span>
      ) : (
        <span>Waiting for the Bot's screen…</span>
      )}
    </span>
  );
}

/**
 * The Bot's browser as a window, in the live full-size view: its bar (tabs, the address, back, forward and reload) over
 * its page, framed as one, the page as large as the space left allows at the browser's own shape. The Browser page
 * draws the person's own browser the same way (`components/browser/browser-screen.tsx`), the page inside the tabs'
 * panel with the address. Sized against the space with container units rather than a measured width, so it fits both
 * ways as the window changes. A turn that is over is a picture rather than a browser, and is drawn as it always was.
 */
function BrowserWindow({
  live,
  botId,
  bar,
  onNavigated,
  children,
}: {
  live: boolean;
  botId: string;
  /** The Bot's browser as this person sees it; undefined until it first answers, when the page is drawn barless. */
  bar: BotBrowserApiState | undefined;
  /** An address typed in the bar went: the keyboard goes back to the page. */
  onNavigated: () => void;
  children: ReactNode;
}) {
  if (!live) return children;
  return (
    // Clipped rather than hidden: a hidden overflow would let this shrink below the screen's own floor.
    <div className="flex min-w-0 flex-1 flex-col overflow-clip rounded-xl border border-border">
      <BotBrowserBar botId={botId} state={bar} onNavigated={onNavigated}>
        <div
          className="flex min-h-80 flex-1 items-center justify-center bg-muted/40 p-2"
          style={{ containerType: "size" }}
        >
          {children}
        </div>
      </BotBrowserBar>
    </div>
  );
}

/**
 * Who has the wheel and Record, in a live full-size view: a column beside the Bot's browser in a wide window, so the
 * page takes the window's height, and under it in a narrow one. A turn that is over keeps them where they always were.
 */
function WheelColumn({
  live,
  children,
}: {
  live: boolean;
  children: ReactNode;
}) {
  if (!live) return children;
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:w-96 lg:shrink-0 lg:overflow-y-auto">
      {children}
    </div>
  );
}

type Props = {
  /** Which computer to watch. One shared computer unless each Bot has been given its own. */
  computerId: string;
  /** Off by default so idle Bot screens do not poll indefinitely. */
  active?: boolean;
  intervalMs?: number;
  /** Width divided by height. Overridable for a Bot whose computer is not the default shape. */
  aspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
  /** Whose screen this is, drawn as a small badge over the frame. Absent, no badge is drawn. */
  name?: string;
  /**
   * The page this turn left the browser on, for a turn that has finished.
   *
   * A conversation is a record, and a record must not change its mind. Without this, reopening a
   * conversation made every past turn fetch the screen as it is now, so an answer about Hacker News
   * from an hour ago sat under a picture of whatever the Bot has open today. The frame was live, the
   * caption was not, and the turn read as though it had browsed somewhere it never went.
   */
  page?: { url?: string; title?: string };
  /**
   * Whether the turn this tile belongs to has ended.
   *
   * SEPARATE FROM HAVING A PAGE. A navigation that was refused, failed or stopped ends without one,
   * and a tile that decided history by "do I have a page" left exactly those turns polling the live
   * screen for ever, under an answer that had nothing to do with what was on it.
   */
  finished?: boolean;
  /**
   * The tool call this tile belongs to, which is what a kept frame is filed under.
   *
   * Without it the tile can still name the page; with it, it can show the page. Optional because the
   * side panel is not a turn and has nothing to remember.
   */
  toolCallId?: string;
  /** How long to wait for a first frame before calling it a problem. Shortened by tests. */
  startupGraceMs?: number;
};

export function ComputerView({
  computerId,
  active = true,
  intervalMs = 1000,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  name,
  page,
  finished,
  toolCallId,
  startupGraceMs = STARTUP_GRACE_MS,
}: Props) {
  const [shot, setShot] = useState<Screenshot | null>(null);
  /**
   * The last screenshot that was attempted and failed. Held, not shown: see `shownProblem` below.
   */
  const [problem, setProblem] = useState<string | null>(null);
  /** What the last poll said about a computer that is not ready, which it says without waking it. */
  const [polledState, setPolledState] = useState<ComputerState | null>(null);
  /** Set once a computer has gone `startupGraceMs` without a frame. */
  const [stalled, setStalled] = useState(false);
  const [expanded, setExpanded] = useState(false);
  /** The full-size view's live screen, which the bar hands the keyboard back to once an address goes. */
  const screen = useRef<LiveScreenHandle>(null);
  const [streamProblem, setStreamProblem] = useState<string | null>(null);
  /** A dropped live stream being retried on its own. A badge, never the overlay. */
  const [reconnecting, setReconnecting] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  /**
   * A finished turn is history, and history is not polled.
   *
   * While a turn runs, the frames are that turn's own and freeze where it left them, which is right.
   * Reopening the conversation later is the case this guards: the component mounts with no frame,
   * and fetching one would put today's page under yesterday's answer. It shows the page that turn
   * actually left open instead, which is the thing being remembered.
   *
   * `page` is what marks a turn as settled history rather than one still going, so a caller that
   * knows nothing about the page keeps the old behaviour and nothing regresses.
   *
   * DELIBERATELY NOT "AND WE HAVE NO FRAME YET". That is what this said first, and it undid itself:
   * restoring the kept frame set the frame, which made the turn stop counting as history, which
   * restarted the polling this exists to prevent, which replaced the restored picture with the live
   * one. The turn being over is the fact; whether a picture has arrived yet is not.
   */
  if (toolCallId && page?.url) rememberTurn(toolCallId, { page });
  const knownPage =
    page?.url !== undefined
      ? page
      : toolCallId
        ? REMEMBERED_TURNS.get(toolCallId)?.page
        : undefined;
  const keptFrame = toolCallId
    ? (REMEMBERED_TURNS.get(toolCallId)?.frame ?? null)
    : null;
  /** Bumped when a frame arrives, because the store it lands in is not React state. */
  const [, setFrameArrived] = useState(0);

  const settled = !active && (finished || Boolean(knownPage));
  const {
    control,
    busy: changingControl,
    change: changeControl,
    refresh: refreshControl,
    someoneElse,
  } = useComputerControl(computerId, !settled);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [sendingSecret, setSendingSecret] = useState(false);
  const pageVisible = usePageVisible();
  const [previewRef, previewIntersecting] = useElementVisible<HTMLElement>();
  /** The signed-in person holds the wheel. Someone else holding it on a shared Bot is not them driving. */
  const driving =
    control?.holder === "human" && !control.transitioning && !someoneElse;
  /** Read by the polling loop without restarting it on control changes. */
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  /** Secret prompts keep the screen live even though the human does not hold the wheel. */
  const secretPending = Boolean(control?.secretWanted);
  const secretPendingRef = useRef(false);
  secretPendingRef.current = secretPending;
  // Held in a ref so a slow response cannot overwrite a newer frame after the component moved on.
  const generation = useRef(0);
  /** Force a short watch window after non-Bot actions such as secret entry. */
  const watchUntil = useRef(0);

  const visualVisible = pageVisible && (expanded || previewIntersecting);

  /*
   * The frame this turn's page was showing, fetched once and then kept.
   *
   * A READ, AND ONLY A READ. The tile used to capture the frame itself once the turn went inactive,
   * and it kept filing the wrong picture: a reopened turn and one that has just finished look
   * identical from in here, the same computer is driven by other conversations between the two, and
   * a resumed computer starts blank. The frame is now taken on the server the moment the navigation
   * succeeds, which is the one moment the screen is certainly showing the page that was asked for,
   * so there is nothing left here to race.
   */
  useEffect(() => {
    if (!toolCallId || !settled) return;
    const remembered = REMEMBERED_TURNS.get(toolCallId);
    /*
     * Asked once per turn, answer or not. Without remembering the empty answer, every turn from
     * before this shipped refetched nothing on every remount, which on a long transcript is one
     * pointless request per turn per scroll.
     */
    if (remembered?.frame || remembered?.asked) return;
    let current = true;

    void (async () => {
      const stored = await readPageFrame(computerId, toolCallId);
      if (!current) return;
      rememberTurn(toolCallId, {
        asked: true,
        ...(stored ? { frame: { base64: stored.frame, url: stored.url } } : {}),
      });
      if (stored) setFrameArrived((n) => n + 1);
    })();

    return () => {
      current = false;
    };
  }, [computerId, toolCallId, settled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `secretPending` intentionally restarts settled polling.
  useEffect(() => {
    if (settled) return;
    if (!visualVisible) return;
    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    // Consecutive identical frames observed during post-action settling.
    let unchanged = 0;
    let lastFrame = "";
    const graceStartedAt = Date.now();

    /** Continue while active, human-driven, secret-pending, or not yet visually settled. */
    const shouldContinue = () => {
      if (active) return true;
      if (drivingRef.current) return true;
      if (secretPendingRef.current) return true;
      if (Date.now() < watchUntil.current) return true;
      if (Date.now() - graceStartedAt > SETTLE_TIMEOUT_MS) return false;
      return unchanged < SETTLED_FRAMES;
    };

    // Always fetch at least one frame; only repeated refreshes are conditional.
    const tick = async () => {
      try {
        const { frame, error, notReady } = await readScreenshot(computerId);
        if (generation.current !== mine) return;

        if (notReady) {
          /*
           * Asleep or starting, said by the server without waking the computer. Not a problem:
           * nothing has failed, so the last failure (if any) is no longer the news.
           */
          setPolledState(notReady.state);
          setProblem(null);
          /*
           * A frame from before the computer went to sleep is not what it shows now, and keeping it
           * would also keep the live stream mounted, which reconnects to a computer nobody woke.
           */
          setShot(null);
        } else if (!frame) {
          setProblem(error ?? "The screen isn't available right now.");
          /*
           * The state is unknown again, not whatever the last not-ready answer said. A stale
           * "absent" would keep calling a computer that is failing "off", and an off computer is
           * never timed out, so the failure would never be shown. Cleared, the status read resumes.
           */
          setPolledState(null);
        } else {
          // Exact byte comparison is the settling signal.
          unchanged = frame.base64 === lastFrame ? unchanged + 1 : 0;
          lastFrame = frame.base64;
          // Decode before swapping to avoid blanking the visible image during data URL changes.
          await preloadFrame(frame.base64);
          if (generation.current !== mine) return;
          setShot(frame);
          setProblem(null);
          setPolledState(null);
        }
      } finally {
        if (generation.current === mine && shouldContinue()) {
          timer = setTimeout(tick, intervalMs);
        }
      }
    };

    void tick();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [computerId, active, intervalMs, secretPending, settled, visualVisible]);

  /*
   * Where the computer is in its life, until there is a picture to show.
   *
   * The status route never wakes a computer, so this is safe to poll while one is starting. It is
   * what the panel knows before its first screenshot has come back, and the only word on a computer
   * the server cannot reach. Once a frame arrives the frame is the answer and this stops asking, and
   * so it does while the screenshot poll is itself reporting the state, which it does every second.
   * A failed status read is "not known yet", never a problem in itself.
   */
  const status = useQuery({
    ...computerStatusQueryOptions(computerId),
    enabled: !settled && visualVisible && shot === null && polledState === null,
    refetchInterval: STATUS_POLL_MS,
    retry: false,
  });
  /** The fresher of the two answers: the poll that just ran, else the status read. */
  const computerState: ComputerState | undefined =
    polledState ?? status.data?.state;
  /** In a turn, an absent computer is one the Bot's action is about to start, not one left off. */
  const asleep = computerState === "absent" && !toolCallId;
  /** Waiting for a first frame, for a reason that can end. A computer that is off waits for the Bot. */
  const waitingForFrame = !settled && visualVisible && shot === null && !asleep;

  useEffect(() => {
    if (!waitingForFrame) {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), startupGraceMs);
    return () => clearTimeout(timer);
  }, [waitingForFrame, startupGraceMs]);

  // Input forwarding lives in LiveScreen on the socket.
  // Escape is bound to the window so it works regardless of overlay focus.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  /*
   * The Bot's browser as the person working in it sees it: the bar above the screen and Record under it. Read only
   * while the screen is open full size and live, every second, as the screen itself is watched; a finished turn is a
   * record and has neither.
   */
  const botBrowser = useQuery({
    ...botBrowserStateQueryOptions(computerId),
    enabled: expanded && !settled,
  });
  /*
   * Read again the moment the wheel changes hands, rather than up to a second later: the bar and Record go live, or
   * still, with the button the person just pressed.
   */
  const holder = control ? `${control.holder}:${control.heldBy ?? ""}` : null;
  useEffect(() => {
    if (holder === null) return;
    void queryClient.invalidateQueries({
      queryKey: botBrowserKeys.state(computerId),
    });
  }, [computerId, holder]);
  /** Whether the full-size view draws the Bot's browser's bar over the screen. A turn that is over has none. */
  const barState = settled ? undefined : botBrowser.data;

  // Always render the card frame; help/secret controls live below the conditional picture.
  /*
   * A finished turn is never "blank": it opened a page, and that is what it shows or names. Only a
   * live browser can be sitting on about:blank.
   */
  const blankBrowser = !settled && shot ? isBlankBrowser(shot) : false;

  const owner = name ? `${name}'s` : "the Bot's";
  /**
   * The problem worth showing, which is not the same as the last one that happened.
   *
   * A computer the server says it cannot reach is a problem at once. Anything else that failed is
   * shown only once the wait has run past what a start can take, because before then a failed
   * screenshot is far more often a browser still launching than a broken computer.
   */
  const shownProblem =
    computerState === "unreachable"
      ? `${capitalise(owner)} computer can't be reached right now.`
      : stalled
        ? (problem ?? "It's taking longer than usual to start.")
        : null;
  /**
   * The calm sentence, when there is no picture and nothing wrong.
   *
   * A ready computer that has simply not sent its first frame yet keeps the plain "Waiting for the
   * Bot's screen…", and so does one whose state is not known yet: saying "Starting" over a computer
   * that is already running would be the panel inventing a delay. A failed screenshot from a computer
   * that is not known to be ready is read as one still coming up.
   */
  const waiting: "starting" | "asleep" | undefined = asleep
    ? "asleep"
    : computerState === "starting" ||
        computerState === "absent" ||
        (problem !== null && computerState !== "ready")
      ? "starting"
      : undefined;

  /*
   * Sized from the ratio, never from the payload, so the frame is identical while a screen is
   * loading, once it arrives, and while the browser has nothing open. A blank browser used to
   * collapse to a strip of text; that made the panel change shape the moment a page opened, and a
   * surface whose whole job is showing a screen kept surprising the layout around it.
   */
  const frameStyle = { aspectRatio, minWidth, minHeight };
  /**
   * What this tile draws: the kept frame for a turn that is over, the live one while it runs.
   *
   * A finished turn never draws `shot`. It may hold one, caught in the render between mounting and
   * its result arriving, and that frame is of whatever the Bot has open now rather than of this turn.
   */
  const drawn = settled
    ? keptFrame
    : shot
      ? { base64: shot.base64, url: shot.url ?? "" }
      : null;
  /** Whether there is a page to draw. A blank browser and an unreadable screen are both "no". */
  const showScreen = drawn !== null && !blankBrowser;
  /**
   * Whether the full-size view has a stream worth opening.
   *
   * Nothing to draw, and it says so in the same words the card does — but somebody holding the wheel
   * gets the live socket whatever is on it, because once a person is driving the stream is the truth
   * about the page and a placeholder over it would be the view arguing with them.
   */
  const showLiveScreen = !settled && (showScreen || driving);
  /**
   * Whether the wheel in somebody's hands is the wheel THIS tile is showing.
   *
   * A person can take control mid-navigation, and the turn then settles under them. `driving` stays
   * true, because it is true: they are driving the browser. It is just not the browser in this
   * picture any more. Left ungated, the frozen tile asserted "You have control" over a page from an
   * hour ago, with the hand-back footer already gone and the backdrop refusing to close because it
   * believed somebody was driving it.
   */
  const wheelHere = driving && !settled;
  /** What the Bot asked for the wheel for, when it asked. Never the person's own take. */
  const reason = botsReason(control);

  const polledScreen = showScreen ? (
    <img
      src={`data:image/png;base64,${drawn.base64}`}
      alt="What the Bot is looking at"
      // Keep unexpected screenshot dimensions inside the reserved frame.
      className="absolute inset-0 h-full w-full object-contain opacity-100 transition-opacity duration-300 starting:opacity-0"
    />
  ) : null;

  return (
    <>
      <figure ref={previewRef} className="overflow-hidden rounded-2xl border">
        {/* Inline preview remains in transcript; click opens a readable full-size view. */}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          /*
           * Opens whether or not there is a picture in it. It used to be disabled without one, and
           * the wheel is down there: a blank browser, a screen that had not arrived yet, or a
           * computer that could not be reached left a person with no way to take control at all —
           * the states where they most want it. With nothing to draw the full-size view shows these
           * same words, and the wheel below them.
           */
          className="relative block w-full cursor-pointer bg-muted"
          style={frameStyle}
          aria-label="Open the Bot's screen full size"
        >
          {polledScreen}

          {/* Whose computer this is — and whose hands are on it — said on the picture itself. */}
          {name || wheelHere ? (
            <span className="absolute right-2 bottom-2 flex items-center gap-1.5">
              {name ? (
                <span className="flex items-center gap-1.5 rounded-full bg-black/60 py-1 pr-2.5 pl-1.5 font-medium text-white text-xs backdrop-blur-sm">
                  <ChannelAvatar participantIds={[computerId]} size={16} />
                  {name}
                </span>
              ) : null}
              {wheelHere ? (
                <span className="rounded-full bg-white px-2.5 py-1 font-medium text-black text-xs shadow-sm">
                  You have control
                </span>
              ) : null}
            </span>
          ) : null}

          {showScreen ? null : (
            <NothingToSee
              blankBrowser={blankBrowser}
              owner={owner}
              page={knownPage}
              problem={shownProblem}
              settled={settled}
              waiting={waiting}
            />
          )}
        </button>

        {/* The request reason appears above the always-available ownership controls. */}
        {!driving && !settled && control?.requested ? (
          <div className="flex items-start justify-between gap-3 border-t bg-amber-500/10 px-3 py-2 text-sm">
            <span>
              <strong className="font-medium">The Bot needs you.</strong>{" "}
              {reason}
            </span>
          </div>
        ) : null}

        {!settled && control?.requested ? (
          <div className="px-3 pb-2 text-sm">
            <button
              type="button"
              className="underline"
              disabled={changingControl}
              onClick={() => void changeControl?.("cancel")}
            >
              Cancel request
            </button>
          </div>
        ) : null}
        {!settled && control?.transitioning ? (
          <p className="px-3 py-2 text-sm">
            {someoneElse
              ? "Finishing the Bot's current action…"
              : "Finishing the Bot's current action before giving you control…"}
          </p>
        ) : null}
        {/*
          The request's own interruption reason is written for the assistant, so the person gets
          their own sentence, and is only asked to act when the assistant is actually waiting on them.
        */}
        {!settled && control?.recoveryRequired ? (
          <p className="px-3 py-2 text-sm">
            The Computer stopped while you had control. Take control to check
            the page, then hand it back to the Bot.
          </p>
        ) : !settled && control?.request?.status === "interrupted" ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            The Computer stopped before anyone took control. The Bot will ask
            again if it still needs you.
          </p>
        ) : null}
        {/*
          Secret values go directly to the page path and are never included in the conversation.
          Audit records that a secret was supplied, not the value.
        */}
        {control?.secretWanted ? (
          <form
            className="border-t bg-muted/40 px-3 py-2 text-sm"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!secret || sendingSecret) return;
              setSendingSecret(true);
              watchUntil.current = Date.now() + SECRET_CONFIRM_MS;
              const result = await supplySecret(computerId, secret);
              setSendingSecret(false);
              // Clear even on failure so plaintext is not left in the DOM.
              setSecret("");
              setSecretProblem(result.ok ? null : (result.error ?? null));
              await refreshControl?.();
            }}
          >
            <label className="block" htmlFor="openbot-secret">
              <span className="font-medium">The Bot needs </span>
              <span>{control.secretWanted}</span>
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="openbot-secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Never shown to the Bot"
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
              />
              <button
                type="submit"
                disabled={!secret || sendingSecret}
                className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {sendingSecret ? "Sending…" : "Send to the page"}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              This goes straight to the page. It isn't shown in the
              conversation, and the Bot never sees it.
            </p>
            {secretProblem ? (
              <p className="mt-1 text-xs text-destructive">{secretProblem}</p>
            ) : null}
          </form>
        ) : null}

        {!settled ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {!control
                ? "Checking who has control…"
                : control.transitioning
                  ? "Finishing the current action…"
                  : driving
                    ? "You have control. Open the screen to click and type."
                    : someoneElse
                      ? "Someone else has control."
                      : "The Bot has control."}
            </span>
            <ComputerControlButton
              computerId={computerId}
              onTakeControl={() => setExpanded(true)}
            />
          </div>
        ) : null}
      </figure>

      {/*
        Portal to body so fixed positioning is measured against the viewport, not containing panes.
      */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            /*
             * Scrolls when the card is taller than the window (a narrow window, with Record under the screen), and the
             * card's auto margins centre it when it is not. Centring with justify-content instead put the card's top out
             * of reach above the window. A live view keeps only a thin margin: the window is for the Bot's browser.
             */
            <div
              role="dialog"
              aria-modal="true"
              aria-label="The Bot's screen"
              className={`fixed inset-0 z-50 flex flex-col overflow-y-auto ${settled ? "p-4 sm:p-8" : "p-2 sm:p-4"}`}
            >
              {/*
                Backdrop closes only while read-only; during driving, Escape remains the exit. A
                turn that is over is always read-only, whoever is holding the live browser.
              */}
              <button
                type="button"
                onClick={() => !wheelHere && setExpanded(false)}
                aria-label="Close the Bot's screen"
                aria-hidden={wheelHere}
                tabIndex={wheelHere ? -1 : 0}
                className={`fixed inset-0 bg-black/80 ${wheelHere ? "cursor-default" : "cursor-zoom-out"}`}
              />
              {/*
                A card holding the screen, with who and the wheel beneath it. A turn that is over is
                only a picture, sized to its width as it always was.

                A live view fills the window, because the Bot's browser is what it is for: the bar and
                the page take everything but a column beside them for the wheel and Record (under them
                in a narrow window), and the page is as large as that space allows at its own shape.
                Never less than a screen a person can work in: in a short, narrow window the card grows
                past it and the view scrolls, so Record is always reachable.
              */}
              <div
                className={`relative m-auto flex w-full min-w-0 shrink-0 flex-col rounded-2xl bg-background shadow-2xl ${settled ? "max-w-[70vw] p-4" : "min-h-[calc(100svh-1rem)] gap-4 p-3 sm:min-h-[calc(100svh-2rem)] lg:h-[calc(100svh-2rem)] lg:flex-row"}`}
              >
                <BrowserWindow
                  live={!settled}
                  botId={computerId}
                  bar={barState}
                  onNavigated={() => screen.current?.focus()}
                >
                  {/*
                  Overlay uses the live socket; the inline card keeps low-cost polling. With no page
                  to draw it reserves the same frame and says the same thing the card does — the
                  wheel below is the reason this view opens at all in that state.
                */}
                  <div
                    className={`relative min-h-0 ${settled ? "max-h-[75vh] overflow-auto rounded-xl" : "overflow-hidden rounded-lg border border-border"} ${showLiveScreen ? "bg-black" : "bg-muted"}`}
                    style={
                      settled
                        ? undefined
                        : {
                            width: `min(100cqw, calc(100cqh * ${aspectRatio}))`,
                          }
                    }
                  >
                    {settled && drawn ? (
                      /*
                       * A record, opened larger. Not a window on the browser.
                       *
                       * Zooming a past turn used to mount the live stream and offer Take control, so
                       * the one gesture for looking closer at what a turn did was also the one that
                       * replaced it with whatever the Bot has open now. The kept frame exists to stop
                       * exactly that; its own zoom control was undoing it.
                       */
                      <div className="relative w-full" style={{ aspectRatio }}>
                        <img
                          alt="What this turn had open"
                          className="absolute inset-0 h-full w-full object-contain"
                          src={`data:image/png;base64,${drawn.base64}`}
                        />
                      </div>
                    ) : showLiveScreen ? (
                      <div className="relative w-full" style={{ aspectRatio }}>
                        <LiveScreen
                          // The person opened this view to drive: taking control puts the keyboard on the screen.
                          autoFocus
                          ref={screen}
                          computerId={computerId}
                          driving={driving}
                          onProblem={setStreamProblem}
                          onReconnecting={setReconnecting}
                          retryKey={retryKey}
                        />
                        {/*
                        A drop being retried, said quietly in a corner. The stream retries on its
                        own with a backoff, and the screen under it is usually back in a second;
                        covering it with the Retry panel made a routine reconnect look like a dead
                        one. The panel below is for when the retries have run out.
                      */}
                        {reconnecting && !streamProblem ? (
                          <span
                            role="status"
                            className="absolute top-2 left-2 rounded-full bg-black/60 px-2.5 py-1 font-medium text-white text-xs backdrop-blur-sm"
                          >
                            Reconnecting…
                          </span>
                        ) : null}
                        {/*
                        A live screen that ends reports why through `onProblem`, and this is the
                        branch that is mounted when it does. Without drawing it here the message
                        landed in `problem`, which only the sibling `NothingToSee` reads, so the
                        screen ended with the stale last frame frozen on the canvas and nothing said.
                      */}
                        {streamProblem ? (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/85 p-4 text-center text-sm text-muted-foreground">
                            <span>{streamProblem}</span>
                            <button
                              type="button"
                              className="underline"
                              onClick={() => {
                                setStreamProblem(null);
                                setRetryKey((value) => value + 1);
                              }}
                            >
                              Retry
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="relative w-full" style={{ aspectRatio }}>
                        <NothingToSee
                          blankBrowser={blankBrowser}
                          owner={owner}
                          page={knownPage}
                          problem={shownProblem}
                          settled={settled}
                          waiting={waiting}
                        />
                      </div>
                    )}
                  </div>
                </BrowserWindow>
                {/*
                  NOT ON A TURN THAT IS OVER. Every past turn used to carry the wheel and the
                  standing "who is driving" prose under a picture of a page it opened an hour ago,
                  offering control of whatever the Bot has open now. Those sentences are about the
                  present and this view is a record; a record does not get a steering wheel.
                */}
                <WheelColumn live={!settled}>
                  {control?.transitioning ? (
                    <p
                      className={
                        settled ? "mt-3 text-center text-sm" : "text-sm"
                      }
                    >
                      {someoneElse
                        ? "Finishing the current action…"
                        : "Finishing the current action before giving you control…"}
                    </p>
                  ) : null}
                  {settled ? null : (
                    <div className="flex items-center justify-center gap-4 lg:flex-col lg:items-start lg:gap-3">
                      <span className="flex min-w-0 items-center gap-2 text-sm lg:flex-col lg:items-start lg:gap-1">
                        {name ? (
                          <span className="flex shrink-0 items-center gap-1.5 font-medium">
                            <ChannelAvatar
                              participantIds={[computerId]}
                              size={20}
                            />
                            {name}
                          </span>
                        ) : null}
                        {driving ? (
                          <span className="truncate text-muted-foreground lg:whitespace-normal">
                            You have control. Click and type on the page.
                            {reason ? ` ${reason}` : null}
                          </span>
                        ) : someoneElse ? (
                          <span className="truncate text-muted-foreground lg:whitespace-normal">
                            Someone else has control.
                          </span>
                        ) : control?.requested ? (
                          <span className="truncate text-muted-foreground lg:whitespace-normal">
                            <strong className="font-medium text-foreground">
                              The Bot needs you.
                            </strong>{" "}
                            {reason}
                          </span>
                        ) : null}
                      </span>
                      <ComputerControlButton computerId={computerId} />
                    </div>
                  )}
                  {/*
                  Record, under the wheel, because it is only for the person holding it. Branched on
                  the data first, so a read that fails after one has answered keeps what it showed.
                */}
                  {settled ? null : botBrowser.data ? (
                    <BotRecordPanel
                      botId={computerId}
                      state={botBrowser.data}
                    />
                  ) : botBrowser.error ? (
                    <p className="text-destructive text-sm" role="alert">
                      Couldn't load the Bot's browser. Close this and open it
                      again.
                    </p>
                  ) : null}
                </WheelColumn>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
