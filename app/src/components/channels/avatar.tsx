import Avatar from "boring-avatars";
import { memo } from "react";
import { cn } from "@/lib/utils";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `size-full` opts the generated SVG out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 *
 * `typing` overlays a working indicator at the bottom-right — three bouncing dots, so a channel
 * whose agent is mid-turn reads as busy from the roster without moving the row's layout.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
  typing = false,
}: {
  participantIds: string[];
  size?: number;
  typing?: boolean;
}) {
  const avatar =
    participantIds.length === 1 ? (
      <Avatar className="size-full" name={participantIds[0]} size={size} />
    ) : (
      <GroupFaces participantIds={participantIds} size={size} />
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {typing ? <TypingBadge /> : null}
    </div>
  );
});

/** Where each face sits in a group's avatar, as fractions of its size, back to front. */
const LAYOUTS = {
  2: {
    diameter: 0.68,
    at: [
      [0, 0],
      [0.32, 0.32],
    ],
  },
  3: {
    diameter: 0.56,
    at: [
      [0.22, 0],
      [0, 0.44],
      [0.44, 0.44],
    ],
  },
} as const;

/**
 * A group's first two or three Bots, overlapping inside the avatar's own square so the row around
 * it keeps its layout. Each face is cut out where a later one covers it, leaving a gap that reads
 * on any background — selected, hovered, or the conversation's header.
 */
function GroupFaces({
  participantIds,
  size,
}: {
  participantIds: string[];
  size: number;
}) {
  const shown = participantIds.slice(0, 3);
  const layout = LAYOUTS[shown.length === 2 ? 2 : 3];
  const diameter = Math.round(size * layout.diameter);
  const gap = Math.max(1, size * 0.05);
  const at = layout.at.map(([x, y]) => [x * size, y * size]);
  return (
    <div className="relative size-full">
      {shown.map((id, i) => {
        const cuts = at.slice(i + 1).map(([x, y]) => {
          const cx = x - at[i][0] + diameter / 2;
          const cy = y - at[i][1] + diameter / 2;
          const r = diameter / 2 + gap;
          return `radial-gradient(circle at ${cx}px ${cy}px, transparent ${r}px, #000 ${r + 0.5}px)`;
        });
        const mask = cuts.length > 0 ? cuts.join(", ") : undefined;
        return (
          <div
            className="absolute overflow-hidden rounded-full"
            key={id}
            style={{
              left: at[i][0],
              top: at[i][1],
              height: diameter,
              width: diameter,
              maskImage: mask,
              WebkitMaskImage: mask,
              maskComposite: "intersect",
              WebkitMaskComposite: "source-in",
            }}
          >
            <Avatar className="size-full" name={id} size={diameter} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Three bouncing dots in a small badge, ringed in the sidebar's own colour so it sits on the
 * avatar as a badge rather than floating over it. The staggered negative delays start each dot at
 * a different point in the same bounce, which is what makes the three read as one wave.
 */
function TypingBadge() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 flex items-center gap-0.5 rounded-full bg-sidebar p-0.5 ring-2 ring-sidebar">
      <span className="sr-only">Working…</span>
      <Dot className="[animation-delay:-0.3s]" />
      <Dot className="[animation-delay:-0.15s]" />
      <Dot />
    </div>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("size-1 rounded-full bg-primary animate-bounce", className)}
    />
  );
}
