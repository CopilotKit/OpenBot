import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type ControlState,
  controlLease,
  readControl,
  releaseControl,
  supplySecret,
  takeControl,
} from "@/lib/computers/control";
import {
  readPageFrame,
  readScreenshot,
  type Screenshot,
} from "@/lib/computers/screen";
import { ChannelAvatar } from "../channels/avatar";
import { LiveScreen } from "./live-screen";

// RFB decoding is substantial and is needed only after somebody opens the full-size computer.
// Keeping it out of the channel's initial bundle avoids charging every conversation for takeover.
const RemoteDesktop = lazy(async () => {
  const module = await import("./remote-desktop");
  return { default: module.RemoteDesktop };
});

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
 * Only an RFB/page-stream connection error may cover the expanded computer.
 *
 * The browser screenshot poll is a sibling surface. It is expected to fail after somebody closes
 * Chromium from the desktop, and showing that failure over the framebuffer would hide the dock used
 * to reopen it. Keeping both inputs here makes that separation a regression-testable decision.
 */
export function desktopOverlayProblem(
  _browserProblem: string | null,
  desktopProblem: string | null,
): string | null {
  return desktopProblem;
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
}: {
  problem: string | null;
  blankBrowser: boolean;
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
          <span className="font-medium">
            You cannot see the screen right now
          </span>
          <span>{problem}</span>
          <span>
            The assistant may still be working. An administrator can check
            whether its computer is running.
          </span>
        </>
      ) : blankBrowser ? (
        <span>The assistant has not opened a page yet.</span>
      ) : (
        <span>Waiting for the assistant's screen…</span>
      )}
    </span>
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
}: Props) {
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** A full-desktop connection problem, separate from the browser screenshot used by the inline tile. */
  const [desktopProblem, setDesktopProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [desktopUnavailable, setDesktopUnavailable] = useState(false);
  const [control, setControl] = useState<ControlState | null>(null);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [sendingSecret, setSendingSecret] = useState(false);
  const lease = controlLease(computerId);
  const driving = control?.holder === "human" && Boolean(lease);
  const visibleDesktopProblem = desktopOverlayProblem(problem, desktopProblem);
  /** Read by the polling loop without restarting it on control changes. */
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  useEffect(() => {
    // Referenced deliberately: a different Bot may run an older image even when this one does not.
    void computerId;
    setDesktopUnavailable(false);
    setDesktopProblem(null);
  }, [computerId]);

  const markDesktopUnavailable = useCallback(() => {
    setDesktopUnavailable(true);
    setDesktopProblem(null);
  }, []);

  /** Release control; the Bot's waiting tool call resumes from this state change. */
  const handBack = async () => {
    const state = await releaseControl(computerId);
    if (state) setControl(state);
  };
  /** Secret prompts keep the screen live even though the human does not hold the wheel. */
  const secretPending = Boolean(control?.secretWanted);
  const secretPendingRef = useRef(false);
  secretPendingRef.current = secretPending;
  // Held in a ref so a slow response cannot overwrite a newer frame after the component moved on.
  const generation = useRef(0);
  /** Force a short watch window after non-Bot actions such as secret entry. */
  const watchUntil = useRef(0);

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
        const { frame, error } = await readScreenshot(computerId);
        if (generation.current !== mine) return;

        if (!frame) {
          setProblem(error ?? "The screen is not available right now.");
        } else {
          // Exact byte comparison is the settling signal.
          unchanged = frame.base64 === lastFrame ? unchanged + 1 : 0;
          lastFrame = frame.base64;
          // Decode before swapping to avoid blanking the visible image during data URL changes.
          await preloadFrame(frame.base64);
          if (generation.current !== mine) return;
          setShot(frame);
          setProblem(null);
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
  }, [computerId, active, intervalMs, secretPending, settled]);

  /** Poll control state independently from screenshot polling so help/secret prompts surface. */
  useEffect(() => {
    if (settled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const state = await readControl(computerId);
      if (!live) return;
      if (state) setControl(state);
      timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [computerId, settled]);

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

  // Always render the card frame; help/secret controls live below the conditional picture.
  /*
   * A finished turn is never "blank": it opened a page, and that is what it shows or names. Only a
   * live browser can be sitting on about:blank.
   */
  const blankBrowser = !settled && shot ? isBlankBrowser(shot) : false;

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
  const showLiveScreen = !settled;
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

  const polledScreen = showScreen ? (
    <img
      src={`data:image/png;base64,${drawn.base64}`}
      alt="What the assistant is looking at"
      // Keep unexpected screenshot dimensions inside the reserved frame.
      className="absolute inset-0 h-full w-full object-contain opacity-100 transition-opacity duration-300 starting:opacity-0"
    />
  ) : null;

  return (
    <>
      <figure className="overflow-hidden rounded-2xl border">
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
          aria-label="Open the assistant's screen full size"
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
              page={knownPage}
              problem={problem}
              settled={settled}
            />
          )}
        </button>

        {/*
         * The Bot ASKING for the wheel, which is not the same thing as a person wanting it.
         *
         * The standing "who is driving" prose and the everyday Take control button live in the
         * full-size view, where there is a page big enough to drive. This row is the exception: a
         * request is an exceptional state with a reason attached, it is the one moment the screen is
         * waiting on a person rather than the other way round, and making them open the full-size
         * view to find out what was wanted would hide the reason behind a click. Taking the wheel
         * from here opens that view, because driving is what they are being asked to do.
         */}
        {!driving && !settled && control?.requested ? (
          <div className="flex items-start justify-between gap-3 border-t bg-amber-500/10 px-3 py-2 text-sm">
            <span>
              <strong className="font-medium">The assistant needs you.</strong>{" "}
              {control.reason}
            </span>
            <button
              type="button"
              onClick={async () => {
                const state = await takeControl(computerId);
                if (state) setControl(state);
                setExpanded(true);
              }}
              className="shrink-0 rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground text-xs"
            >
              Take control
            </button>
          </div>
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
              const state = await readControl(computerId);
              if (state) setControl(state);
            }}
          >
            <label className="block" htmlFor="openbot-secret">
              <span className="font-medium">The assistant needs </span>
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
                placeholder="Typed here, never shown to the assistant"
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
              This goes straight to the page. It is not shown in the
              conversation and the assistant never receives it.
            </p>
            {secretProblem ? (
              <p className="mt-1 text-xs text-destructive">{secretProblem}</p>
            ) : null}
          </form>
        ) : null}

        {/*
         * The inline card carries no persistent footer: taking the wheel, handing it back, and the
         * standing "who is driving" prose all live in the full-size view, where there is a page big
         * enough to drive. The two rows above appear only while the Bot is stuck — waiting on a
         * credential, or asking for the wheel — and go again when it is not.
         */}
      </figure>

      {/*
        Portal to body so fixed positioning is measured against the viewport, not containing panes.
      */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="The assistant's screen"
              className="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 sm:p-8"
            >
              {/*
                Backdrop closes only while read-only; during driving, Escape remains the exit. A
                turn that is over is always read-only, whoever is holding the live browser.
              */}
              <button
                type="button"
                onClick={() => !wheelHere && setExpanded(false)}
                aria-label="Close the assistant's screen"
                aria-hidden={wheelHere}
                tabIndex={wheelHere ? -1 : 0}
                className={`absolute inset-0 bg-black/80 ${wheelHere ? "cursor-default" : "cursor-zoom-out"}`}
              />
              {/* A card holding the screen, with who and the wheel centered beneath it. */}
              <div className="relative flex w-full max-w-[70vw] min-w-0 flex-col rounded-2xl bg-background p-4 shadow-2xl">
                {/*
                  Overlay uses the live socket; the inline card keeps low-cost polling. With no page
                  to draw it reserves the same frame and says the same thing the card does — the
                  wheel below is the reason this view opens at all in that state.
                */}
                <div
                  className={`relative max-h-[75vh] min-h-0 overflow-auto rounded-xl ${showLiveScreen ? "bg-black" : "bg-muted"}`}
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
                      {desktopUnavailable ? (
                        <LiveScreen
                          computerId={computerId}
                          driving={driving}
                          lease={lease}
                          onProblem={setDesktopProblem}
                        />
                      ) : (
                        <Suspense
                          fallback={
                            <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
                              Connecting to the computer…
                            </div>
                          }
                        >
                          <RemoteDesktop
                            computerId={computerId}
                            driving={driving}
                            lease={lease}
                            onProblem={setDesktopProblem}
                            onUnavailable={markDesktopUnavailable}
                          />
                        </Suspense>
                      )}
                      {/*
                        A live desktop that ends reports why through its own problem state. This must
                        stay separate from the inline browser screenshot: a deliberately closed
                        browser makes that poll fail while the VM display and its launchers remain
                        healthy, and drawing that failure here covered the very dock used to reopen it.
                      */}
                      {visibleDesktopProblem ? (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/85 p-4 text-center text-sm text-muted-foreground">
                          <span>{visibleDesktopProblem}</span>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="relative w-full" style={{ aspectRatio }}>
                      <NothingToSee
                        blankBrowser={blankBrowser}
                        page={knownPage}
                        problem={problem}
                        settled={settled}
                      />
                    </div>
                  )}
                </div>
                {/*
                  NOT ON A TURN THAT IS OVER. Every past turn used to carry the wheel and the
                  standing "who is driving" prose under a picture of a page it opened an hour ago,
                  offering control of whatever the Bot has open now. Those sentences are about the
                  present and this view is a record; a record does not get a steering wheel.
                */}
                {settled ? null : (
                  <div className="mt-4 flex items-center justify-center gap-4">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
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
                        <span className="truncate text-muted-foreground">
                          You have control — click and type on the page.
                          {control?.reason ? ` ${control.reason}` : null}
                        </span>
                      ) : control?.requested ? (
                        <span className="truncate text-muted-foreground">
                          <strong className="font-medium text-foreground">
                            The assistant needs you.
                          </strong>{" "}
                          {control.reason}
                        </span>
                      ) : null}
                    </span>
                    {driving ? (
                      <button
                        type="button"
                        onClick={() => void handBack()}
                        className="shrink-0 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm"
                      >
                        Hand back
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={async () => {
                          const state = await takeControl(computerId);
                          if (state) setControl(state);
                        }}
                        className="shrink-0 rounded-md border px-3 py-1.5 font-medium text-sm"
                      >
                        Take control
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
