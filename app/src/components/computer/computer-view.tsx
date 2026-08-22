import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ControlState,
  readControl,
  releaseControl,
  supplySecret,
  takeControl,
} from "@/lib/computers/control";
import { readScreenshot, type Screenshot } from "@/lib/computers/screen";
import { LiveScreen } from "./live-screen";
import { ComputerPlaceholder } from "./placeholder";

/** Explicit blank-browser URLs use placeholder artwork; missing URL fields are treated as real pages. */
function isBlankBrowser(shot: Screenshot): boolean {
  if (shot.url === undefined) return false;
  const url = shot.url.trim();
  return url === "" || url === "about:blank";
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
};

export function ComputerView({
  computerId,
  active = true,
  intervalMs = 1000,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
}: Props) {
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [control, setControl] = useState<ControlState | null>(null);
  /** Held only until it is sent. Never lifted into a URL, a log, or anything that outlives this form. */
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [sendingSecret, setSendingSecret] = useState(false);
  const driving = control?.holder === "human";
  /** Read by the polling loop without restarting it on control changes. */
  const drivingRef = useRef(false);
  drivingRef.current = driving;

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `secretPending` intentionally restarts settled polling.
  useEffect(() => {
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
  }, [computerId, active, intervalMs, secretPending]);

  /** Poll control state independently from screenshot polling so help/secret prompts surface. */
  useEffect(() => {
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
  }, [computerId]);

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
  const blankBrowser = shot ? isBlankBrowser(shot) : false;

  /*
   * Sized from the ratio, never from the payload, so the frame is identical while a screen is
   * loading and once it arrives.
   *
   * A browser that has opened nothing is the exception. Reserving a screen-sized frame for it put a
   * placeholder the height of a browser window into the middle of a conversation, above an answer
   * that never involved the browser at all: a Bot asked about Google Drive rendered a full-size
   * empty panel saying it had not opened a page. Nothing is loading there and nothing is coming, so
   * there is no layout jump to protect against and no reason to take the room.
   */
  const frameStyle = blankBrowser
    ? { minWidth }
    : { aspectRatio, minWidth, minHeight };
  /** Blank browser placeholders should not be opened as readable screens. */
  const showScreen = shot !== null && !blankBrowser;

  const polledScreen = showScreen ? (
    <img
      src={`data:image/png;base64,${shot.base64}`}
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
          // Disabled while blank/waiting but still reserves the frame.
          disabled={!showScreen}
          className="relative block w-full bg-muted enabled:cursor-zoom-in"
          style={frameStyle}
          aria-label="Open the assistant's screen full size"
        >
          {polledScreen}

          {blankBrowser ? (
            <ComputerPlaceholder className="absolute inset-0 h-full w-full" />
          ) : null}
          {/* The blank state is a line of text, so it needs its own height rather than the frame's. */}
          {blankBrowser ? <span className="block py-6" /> : null}

          {showScreen ? null : (
            <span
              className={`absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-sm ${
                blankBrowser
                  ? "bg-black/25 text-white"
                  : "text-muted-foreground"
              }`}
            >
              {problem ? (
                <>
                  <span className="font-medium">
                    You cannot see the screen right now
                  </span>
                  <span>{problem}</span>
                  <span className={blankBrowser ? "text-white/80" : undefined}>
                    The assistant may still be working. An administrator can
                    check whether its computer is running.
                  </span>
                </>
              ) : blankBrowser ? (
                <span>The assistant has not opened a page yet.</span>
              ) : (
                <span>Waiting for the assistant's screen…</span>
              )}
            </span>
          )}
        </button>

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

        {driving ? (
          <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-3 py-2 text-sm">
            <span>You have control of this browser.</span>
            <span className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="rounded-md border px-3 py-1 text-xs font-medium"
              >
                Open full size
              </button>
              <button
                type="button"
                onClick={() => void handBack()}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                Hand back
              </button>
            </span>
          </div>
        ) : null}

        {/*
         * The wheel is offered whether or not the Bot asked for it.
         *
         * It only used to appear once the Bot called `computer_request_help`, which made the button
         * depend on the Bot getting one instruction right. It does not always: asked to open a page
         * behind a sign-in, a Bot answered "If you'd like, I can prompt you to take control … would
         * you like to proceed with signing in?" and called nothing. The person was told to take
         * control, and there was no control to take. The prompt already forbids that sentence in as
         * many words, so the answer is not more prose: it is that a person who wants their own
         * browser should not have to be offered it first.
         *
         * The amber row stays the Bot ASKING, which is a different thing and still worth its own
         * colour and its reason. Without a request this is a quiet control that says who is driving.
         */}
        {!driving ? (
          <div
            className={`flex items-start justify-between gap-3 border-t px-3 py-2 text-sm ${
              control?.requested ? "bg-amber-500/10" : "bg-muted/40"
            }`}
          >
            <span>
              {control?.requested ? (
                <>
                  <strong className="font-medium">
                    The assistant needs you.
                  </strong>{" "}
                  {control.reason}
                </>
              ) : (
                "The assistant is driving. You can take over whenever you want."
              )}
            </span>
            <button
              type="button"
              onClick={async () => {
                const state = await takeControl(computerId);
                if (state) setControl(state);
                setExpanded(true);
              }}
              className={`shrink-0 rounded-md px-3 py-1 text-xs font-medium ${
                control?.requested
                  ? "bg-primary text-primary-foreground"
                  : "border"
              }`}
            >
              Take control
            </button>
          </div>
        ) : null}
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
              className="fixed inset-0 z-50 flex flex-col p-4 sm:p-8"
            >
              {/* Backdrop closes only while read-only; during driving, Escape remains the exit. */}
              <button
                type="button"
                onClick={() => !driving && setExpanded(false)}
                aria-label="Close the assistant's screen"
                aria-hidden={driving}
                tabIndex={driving ? -1 : 0}
                className={`absolute inset-0 bg-black/80 ${driving ? "cursor-default" : "cursor-zoom-out"}`}
              />
              <div className="relative mb-3 flex items-center justify-between gap-4 text-sm text-white">
                <span className="pointer-events-none">
                  {driving ? (
                    <>
                      <strong className="font-medium">You have control.</strong>{" "}
                      Click and type on the page as you normally would.
                      {control?.reason ? ` ${control.reason}` : null}
                    </>
                  ) : (
                    <>The assistant's screen{active ? ", updating live" : ""}</>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {driving ? (
                    <button
                      type="button"
                      onClick={() => {
                        setExpanded(false);
                        void handBack();
                      }}
                      className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black"
                    >
                      Hand back to the assistant
                    </button>
                  ) : (
                    /* Offered here too, and for the same reason: see the inline card above. */
                    <button
                      type="button"
                      onClick={async () => {
                        const state = await takeControl(computerId);
                        if (state) setControl(state);
                      }}
                      className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black"
                    >
                      Take control
                    </button>
                  )}
                  <span className="pointer-events-none text-white/70">
                    {driving
                      ? "Press Escape to close"
                      : "Click anywhere or press Escape to close"}
                  </span>
                </span>
              </div>
              {/* Overlay uses the live socket; the inline card keeps low-cost polling. */}
              <div className="relative min-h-0 flex-1 overflow-auto rounded-lg bg-black">
                <LiveScreen
                  computerId={computerId}
                  driving={driving}
                  onProblem={setProblem}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
