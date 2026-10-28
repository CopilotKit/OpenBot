import { memo } from "react";
import { BotOrb, type BotOrbState } from "@/components/agents/orb/bot-orb";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * Each face is the Bot's orb, with the look its id picks: the same face `AbstractAvatar` draws from
 * the seed, which is the id unless a tenant package set one or the Bot was copied from another
 * (a copy keeps its source's seed). Clipped to its circle, so its glow
 * never spills into the row.
 *
 * `typing` marks a channel whose Bot is mid-turn: every face works, and a still dot at the
 * bottom-right says so without moving the row's layout. `state` sets what the faces show instead.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
  typing = false,
  state = typing ? "thinking" : "idle",
}: {
  participantIds: string[];
  size?: number;
  typing?: boolean;
  /** What every face shows. Working while `typing`, resting otherwise. */
  state?: BotOrbState;
}) {
  const avatar =
    participantIds.length === 1 ? (
      <span className="block size-full overflow-hidden rounded-full">
        <BotOrb seed={participantIds[0]} size={size} state={state} />
      </span>
    ) : (
      <GroupFaces participantIds={participantIds} size={size} state={state} />
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {typing ? <BusyDot /> : null}
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
  state,
}: {
  participantIds: string[];
  size: number;
  state: BotOrbState;
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
            <BotOrb seed={id} size={diameter} state={state} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A still dot in the working colour, ringed so it sits on the avatar as a badge rather than floating
 * over it. Still on purpose: an orb this small only blinks, and reduced motion stills it entirely, so
 * the faces working is too slight to read as busy from across the roster. The ring is the ground the
 * avatar sits on, the sidebar's own unless a row lit behind it sets `--avatar-ground`.
 */
function BusyDot() {
  return (
    <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-status-working ring-2 ring-(--avatar-ground,var(--sidebar))">
      <span className="sr-only">Working…</span>
    </span>
  );
}
