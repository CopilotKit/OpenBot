import { IconFolderFilled, IconLock } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A desktop mid-task, drawn rather than screenshotted: a browser window and a Finder window with
 * files, floating over whatever wallpaper sits behind them.
 *
 * Built the way Tailark builds its workspace illustrations — theme tokens, thin borders, skeleton
 * bars where text would be — so it needs no asset, follows the theme, and never shows a stale
 * product screenshot. Decorative only: hidden from the tree and inert to the pointer.
 */
export function DesktopIllustration({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 select-none",
        className,
      )}
    >
      <BrowserWindow className="absolute top-[9%] left-[7%] w-[58%]" />
      <FinderWindow className="absolute right-[6%] bottom-[8%] w-[48%]" />
      <PointerCursor />
    </div>
  );
}

/**
 * The tour's rhythm, shared by every animated value so they stay in step.
 *
 * Nine keyframes make eight segments, alternating hold and travel: the cursor pauses where a
 * person would, then moves. Easings are per segment for the same reason they differ per value —
 * a pointer launches fast and glides in ({@link EASE_OUT}, the app's entrance curve), while a
 * click presses sharply and releases with a little pop (`backOut`). One curve across the whole
 * loop is what made it read as a metronome.
 */
const TOUR = {
  duration: 10,
  repeat: Number.POSITIVE_INFINITY,
  times: [0, 0.1, 0.28, 0.38, 0.56, 0.66, 0.84, 0.92, 1],
};
/** Hold segments do not move, so their curve is irrelevant; travel segments glide in. */
const PATH_EASE = [
  "linear",
  [...EASE_OUT],
  "linear",
  [...EASE_OUT],
  "linear",
  [...EASE_OUT],
  "linear",
  [...EASE_OUT],
] as const;
/** The click: a sharp press on each hold, released with a slight overshoot on the way out. */
const CLICK_EASE = [
  "easeOut",
  "backOut",
  "easeOut",
  "backOut",
  "easeOut",
  "backOut",
  "easeOut",
  "backOut",
] as const;

/**
 * The agent's pointer, forever mid-errand: browser button, a card, then the Finder's files.
 *
 * Percentages rather than pixels, so the same journey fits whatever size the illustration is
 * drawn at.
 */
function PointerCursor() {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      animate={
        reducedMotion
          ? undefined
          : {
              left: [
                "55%",
                "55%",
                "30%",
                "30%",
                "64%",
                "64%",
                "82%",
                "82%",
                "55%",
              ],
              top: [
                "20%",
                "20%",
                "48%",
                "48%",
                "64%",
                "64%",
                "76%",
                "76%",
                "20%",
              ],
              scale: [1, 0.75, 1, 0.75, 1, 0.75, 1, 0.75, 1],
            }
      }
      className="absolute top-[20%] left-[55%]"
      initial={false}
      transition={{
        left: { ...TOUR, ease: [...PATH_EASE] },
        top: { ...TOUR, ease: [...PATH_EASE] },
        scale: { ...TOUR, ease: [...CLICK_EASE] },
      }}
    >
      {/* Tabler's pointer-2, inlined: the installed icon package predates it. */}
      <svg
        aria-hidden="true"
        className="size-5 text-foreground drop-shadow-sm"
        fill="none"
        focusable="false"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          className="fill-background"
          d="M14.185 13.14l5.644 -2.202c1.625 -.634 1.538 -2.962 -.13 -3.473l-14.319 -4.382c-1.41 -.431 -2.73 .888 -2.298 2.298l4.382 14.318c.51 1.668 2.84 1.755 3.473 .13l2.202 -5.644a1.84 1.84 0 0 1 1.045 -1.045"
        />
      </svg>
    </motion.div>
  );
}

/** A text line that is deliberately not text. */
function Line({ className }: { className?: string }) {
  return (
    <div
      className={cn("h-1.5 rounded-full bg-muted-foreground/20", className)}
    />
  );
}

function WindowFrame({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card shadow-black/5 shadow-lg",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Traffic lights, monochrome on purpose: the theme's grays, not macOS's colors. */
function TrafficLights() {
  return (
    <div className="flex items-center gap-1.5">
      <span className="size-2 rounded-full bg-muted-foreground/25" />
      <span className="size-2 rounded-full bg-muted-foreground/25" />
      <span className="size-2 rounded-full bg-muted-foreground/25" />
    </div>
  );
}

function BrowserWindow({ className }: { className?: string }) {
  return (
    <WindowFrame className={className}>
      <div className="flex items-center border-border border-b px-2.5 py-1.5">
        <TrafficLights />
        {/* The address pill; the empty span mirrors the lights so it centers truly. */}
        <div className="mx-auto flex h-4.5 w-2/5 items-center justify-center gap-1 rounded-full bg-muted px-2">
          <IconLock className="size-2.5 text-muted-foreground/60" />
          <Line className="h-1 w-14 bg-muted-foreground/25" />
        </div>
        <span className="w-11" />
      </div>

      <div className="space-y-2.5 p-3">
        <div className="flex items-center gap-2">
          <div className="size-4 rounded bg-muted" />
          <Line className="w-10" />
          <Line className="w-8" />
          <div className="ml-auto h-4 w-12 rounded-md bg-primary/15" />
        </div>

        <div className="space-y-1.5 pt-1">
          <Line className="h-2 w-2/3 bg-muted-foreground/30" />
          <Line className="w-1/2" />
        </div>

        <div className="grid grid-cols-3 gap-2 pt-1">
          {["a", "b", "c"].map((card) => (
            <div
              className="rounded-md border border-border bg-background p-1.5"
              key={card}
            >
              <div className="h-9 rounded-sm bg-muted" />
              <Line className="mt-1.5 h-1 w-3/4" />
              <Line className="mt-1 h-1 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    </WindowFrame>
  );
}

/** A document glyph drawn in CSS: a page with a folded corner and two lines of nothing. */
function FileGlyph() {
  return (
    <div className="relative h-8 w-6.5 rounded-[3px] border border-border bg-background">
      <div className="absolute top-0 right-0 size-2 rounded-bl-[3px] border-border border-b border-l bg-muted" />
      <div className="absolute inset-x-1 bottom-1.5 space-y-1">
        <Line className="h-0.75 w-full" />
        <Line className="h-0.75 w-2/3" />
      </div>
    </div>
  );
}

function FolderGlyph() {
  return <IconFolderFilled className="size-8 text-muted-foreground/25" />;
}

function FinderWindow({ className }: { className?: string }) {
  const items: Array<{ key: string; folder: boolean }> = [
    { key: "reports", folder: true },
    { key: "invoice", folder: false },
    { key: "assets", folder: true },
    { key: "notes", folder: false },
    { key: "draft", folder: false },
    { key: "archive", folder: true },
  ];

  return (
    <WindowFrame className={className}>
      <div className="flex items-center border-border border-b px-2.5 py-1.5">
        <TrafficLights />
        <Line className="mx-auto h-1 w-14 bg-muted-foreground/25" />
        <span className="w-11" />
      </div>

      <div className="flex">
        <div className="w-14 space-y-1.5 border-border border-r bg-muted/40 p-2">
          {["one", "two", "three", "four"].map((row) => (
            <div className="flex items-center gap-1" key={row}>
              <span className="size-1.5 rounded-[2px] bg-muted-foreground/25" />
              <Line className="h-0.75 w-7" />
            </div>
          ))}
        </div>

        <div className="grid flex-1 grid-cols-3 gap-x-1 gap-y-2 p-2.5">
          {items.map((item) => (
            <div className="flex flex-col items-center gap-1" key={item.key}>
              {item.folder ? <FolderGlyph /> : <FileGlyph />}
              <Line className="h-0.75 w-7" />
            </div>
          ))}
        </div>
      </div>
    </WindowFrame>
  );
}
