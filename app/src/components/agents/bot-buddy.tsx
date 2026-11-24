import { BuddyAvatar, useBuddy } from "@openbot/buddy/react";
import { useQuery } from "@tanstack/react-query";
import { useReducedMotion } from "motion/react";
import { type CSSProperties, useMemo } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type BuddyActivity,
  buddyFor,
  type DrawnBuddy,
  poseFor,
} from "@/lib/buddies/buddy";
import { ownBuddiesQueryOptions } from "@/lib/buddies/queries";
import { orbPalette } from "@/lib/orb-palette";

/** At this size and smaller, a resting buddy is its still picture: no clip plays. */
const STILL_MAX_SIZE = 32;

/**
 * The buddy a Bot is drawn as, for the person looking: the one they chose for it, or the stock buddy
 * its seed picks. A Bot is found by its seed, which is how every place that draws one names it.
 */
export function useBotBuddy(seed: string): DrawnBuddy {
  const { data: choice } = useQuery({
    ...agentListQueryOptions(),
    select: (bots) => bots.find((bot) => bot.avatarSeed === seed)?.buddy,
  });
  const { data: own } = useQuery({
    ...ownBuddiesQueryOptions(),
    enabled: choice?.startsWith("own:") ?? false,
  });
  return useMemo(() => buddyFor(seed, choice, own), [seed, choice, own]);
}

/** The disc behind a buddy: a soft wash of the Bot's own colour, so it stays its colour everywhere. */
function discStyle(seed: string, size: number): CSSProperties {
  const { c1 } = orbPalette(seed);
  return {
    "--buddy-bg": `color-mix(in oklab, ${c1} 22%, var(--background))`,
    "--buddy-border": "color-mix(in oklab, var(--foreground) 10%, transparent)",
    height: size,
    width: size,
  } as CSSProperties;
}

/**
 * A Bot drawn as its buddy. Small and resting, it is the buddy's still picture; larger, or while the
 * Bot works, waits on the person or has just finished, the pose for that plays on a loop. Under
 * reduced motion it is always the still picture.
 */
export function BotBuddy({
  seed,
  name,
  size = 32,
  activity = "idle",
  buddy: given,
  still: keepStill = false,
}: {
  seed: string;
  name: string;
  size?: number;
  activity?: BuddyActivity;
  /** Draw this buddy instead of the Bot's own, as the picker previews one. */
  buddy?: DrawnBuddy;
  /** Its still picture whatever the Bot is doing, as where something covers it. */
  still?: boolean;
}) {
  const own = useBotBuddy(seed);
  const buddy = given ?? own;
  const reduceMotion = useReducedMotion();
  const still =
    keepStill ||
    reduceMotion ||
    (size <= STILL_MAX_SIZE && activity === "idle");

  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0"
      data-buddy={buddy.key}
      style={discStyle(seed, size)}
    >
      <span aria-hidden="true" className="contents">
        {still ? (
          <BuddyStill buddy={buddy} size={size} />
        ) : (
          <BuddyLive activity={activity} buddy={buddy} size={size} />
        )}
      </span>
    </span>
  );
}

function BuddyStill({ buddy, size }: { buddy: DrawnBuddy; size: number }) {
  return (
    <span
      className="block size-full overflow-hidden rounded-full bg-(--buddy-bg) ring-1 ring-foreground/10"
      style={{ height: size, width: size }}
    >
      <img
        alt=""
        className="size-full object-cover"
        decoding="async"
        draggable={false}
        loading="lazy"
        src={buddy.avatarUrl}
      />
    </span>
  );
}

function BuddyLive({
  buddy,
  size,
  activity,
}: {
  buddy: DrawnBuddy;
  size: number;
  activity: BuddyActivity;
}) {
  // The activity's pose is the buddy's resting pose, so it loops for as long as the Bot does it.
  const homePose = poseFor(buddy, activity) ?? undefined;
  const { buddyProps } = useBuddy({
    avatarUrl: buddy.avatarUrl,
    clips: buddy.clips,
    homePose,
    name: buddy.name,
  });
  return <BuddyAvatar {...buddyProps} shadow="none" size={size} />;
}
