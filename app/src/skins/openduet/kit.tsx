import type { Icon } from "@tabler/icons-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * The pieces OpenDuet's screens are built from, on OpenDuet's tokens: the white card, the glass
 * disc, the icon tile, the pill buttons, the status line. Drawn once here so every screen in the
 * skin shares one weight, one radius and one set of colours.
 */

/** The focus ring every control in the skin draws: the accent, soft. */
export const FOCUS =
  "outline-none focus-visible:ring-3 focus-visible:ring-openduet-accent/40";

/** A white card with a hairline and a soft drop. `glass` floats it over a scrolling screen. */
export function DuetCard({
  className,
  raised = false,
  glass = false,
  ...props
}: ComponentProps<"div"> & { raised?: boolean; glass?: boolean }) {
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-[20px] text-openduet-ink",
        glass
          ? "openduet-glass shadow-openduet-glass"
          : [
              "bg-openduet-card",
              raised ? "shadow-openduet-raised" : "shadow-openduet-card",
            ],
        className,
      )}
      {...props}
    />
  );
}

/** A round glass control over the screen: the header's discs, Tasks' sort and search. */
export const DISC = cn(
  "openduet-glass grid shrink-0 place-items-center rounded-full text-openduet-ink shadow-openduet-glass transition-transform duration-[120ms] active:scale-95",
  FOCUS,
);

const TILE_TONES = {
  neutral: "bg-openduet-tile text-openduet-ink-2",
  done: "bg-openduet-done-soft text-openduet-done",
  accent: "bg-openduet-accent-soft text-openduet-accent",
  problem: "bg-openduet-problem-soft text-openduet-problem",
  working: "bg-openduet-working-soft text-openduet-working",
  needs: "bg-openduet-needs-soft text-openduet-needs",
} as const;

export type TileTone = keyof typeof TILE_TONES;

/** A rounded square holding one glyph. Grey unless the colour says how something stands. */
export function Tile({
  icon: Glyph,
  tone = "neutral",
  size = 40,
}: {
  icon: Icon;
  tone?: TileTone;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center", TILE_TONES[tone])}
      style={{ width: size, height: size, borderRadius: size * 0.28 }}
    >
      <Glyph size={Math.round(size * 0.52)} stroke={1.9} />
    </span>
  );
}

/** The hairline between parts of a card. */
export function Rule() {
  return <div aria-hidden className="mx-4 h-px bg-openduet-hair-2" />;
}

/**
 * A pill button that shares its row: black for the answer that moves things on, outlined for the
 * other. Allow once and Deny, Start as task and Dismiss.
 */
export function PillButton({
  children,
  primary = false,
  small = false,
  className,
  ...props
}: ComponentProps<"button"> & { primary?: boolean; small?: boolean }) {
  return (
    <button
      className={cn(
        "inline-flex min-h-11 min-w-0 flex-1 items-center justify-center rounded-full px-4 font-semibold transition-[filter,transform,opacity] active:scale-[0.98] disabled:opacity-50",
        small ? "openduet-type-sub" : "openduet-type-body basis-[7rem]",
        primary
          ? "bg-openduet-black text-openduet-on-black hover:brightness-125"
          : "text-openduet-ink shadow-[inset_0_0_0_1px_var(--openduet-hair)] hover:bg-openduet-tile",
        FOCUS,
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

/** How a row stands, in its colour, as OpenDuet colours a status word. */
export type Standing = "needs" | "working" | "scheduled" | "problem";

const STANDING_TONE: Record<Standing, string> = {
  needs: "text-openduet-needs",
  working: "text-openduet-working",
  scheduled: "text-openduet-ink-3",
  problem: "text-openduet-problem",
};

/**
 * The one line under a row's title: the status word in its colour, then the detail in grey, cut
 * with an ellipsis rather than wrapped.
 */
export function StatusLine({
  standing,
  word,
  children,
}: {
  standing: Standing;
  word: string;
  children?: ReactNode;
}) {
  return (
    <p
      className="openduet-type-sub mt-1 truncate text-openduet-ink-2"
      data-standing={standing}
    >
      <span className={STANDING_TONE[standing]}>{word}</span>
      {children ? <> · {children}</> : null}
    </p>
  );
}

/** A small grey label: who, and where from, under a card's title. */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="openduet-type-caption mt-1 font-medium text-openduet-ink-3">
      {children}
    </p>
  );
}
