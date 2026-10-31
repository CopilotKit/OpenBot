import { useQuery } from "@tanstack/react-query";
import Avatar from "boring-avatars";
import { memo, type ReactNode } from "react";
import { useBotLook } from "@/components/agents/bot-look";
import { BotOrb, type BotOrbState } from "@/components/agents/bot-orb";
import { agentListQueryOptions } from "@/lib/agents/queries";

/**
 * Memoized roster avatar. Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `size-full` opts the generated SVG out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 *
 * `typing` marks a channel whose Bot is mid-turn: every orb works, and a still dot at the
 * bottom-right says so without moving the row's layout. `needsYou` marks one waiting on the person
 * (an approval or a question), with the same dot in the needs colour; it outranks busy, since the
 * Bot cannot go on until the person answers. `state` sets what the orbs show instead.
 *
 * Where Bots are orbs (`useBotLook`), each is drawn from its `avatarSeed`, as `AbstractAvatar`
 * draws it, so a Bot is one color everywhere; a skin that has not opted in keeps the faces. The orbs
 * are hidden from screen readers: the row beside the avatar names the conversation, and an id read
 * aloud would name nothing.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
  typing = false,
  needsYou = false,
  state = typing ? "working" : "idle",
}: {
  participantIds: string[];
  size?: number;
  typing?: boolean;
  /** An approval or a question in the conversation waits on the person. */
  needsYou?: boolean;
  /** What every orb shows. Working while `typing`, resting otherwise. A face shows no state. */
  state?: BotOrbState;
}) {
  const orbs = useBotLook() === "orb";
  const face: Face = orbs
    ? (id, faceSize) => <OrbFace id={id} size={faceSize} state={state} />
    : boringFace;
  const avatar =
    participantIds.length === 1 ? (
      face(participantIds[0], size)
    ) : (
      <GroupFaces
        face={face}
        layout={orbs ? ORB_PAIR : participantIds.length === 2 ? 2 : 3}
        participantIds={participantIds}
        size={size}
      />
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {needsYou ? (
        <StatusDot label="Needs you" tone="bg-status-needs" />
      ) : typing ? (
        <StatusDot label="Working…" tone="bg-status-working" />
      ) : null}
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

type Layout = {
  diameter: number;
  at: readonly (readonly [number, number])[];
};

/** The orbs' group: the first two Bots side by side, overlapping by a third of an orb. */
const ORB_PAIR: Layout = {
  diameter: 0.6,
  at: [
    [0, 0.2],
    [0.4, 0.2],
  ],
};

type Face = (id: string, size: number) => ReactNode;

function boringFace(id: string, size: number) {
  return <Avatar className="size-full" name={id} size={size} />;
}

/** A participant that is not a listed Bot, such as a computer, is seeded by its id. */
function OrbFace({
  id,
  size,
  state,
}: {
  id: string;
  size: number;
  state: BotOrbState;
}) {
  const { data: seed } = useQuery({
    ...agentListQueryOptions(),
    select: (agents) => agents.find((agent) => agent.id === id)?.avatarSeed,
  });
  return (
    <span aria-hidden="true" className="contents" data-state={state}>
      <BotOrb name={id} seed={seed ?? id} size={size} state={state} />
    </span>
  );
}

/**
 * A group's first Bots, as many as the layout places, overlapping inside the avatar's own square so
 * the row around it keeps its layout. Each face is cut out where a later one covers it, leaving a gap that reads
 * on any background — selected, hovered, or the conversation's header.
 */
function GroupFaces({
  face,
  layout: chosen,
  participantIds,
  size,
}: {
  face: Face;
  layout: keyof typeof LAYOUTS | Layout;
  participantIds: string[];
  size: number;
}) {
  const layout: Layout = typeof chosen === "number" ? LAYOUTS[chosen] : chosen;
  const shown = participantIds.slice(0, layout.at.length);
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
            {face(id, diameter)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A still dot in a status colour, ringed so it sits on the avatar as a badge rather than floating
 * over it: working, or needs you. Still on purpose: reduced motion stills the orb, and a skin's faces
 * show no state at all, so the avatar alone would not read from across the roster. The ring is the
 * ground the avatar sits on, the sidebar's own unless a row lit behind it sets `--avatar-ground`.
 */
function StatusDot({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-(--avatar-ground,var(--sidebar)) ${tone}`}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}
