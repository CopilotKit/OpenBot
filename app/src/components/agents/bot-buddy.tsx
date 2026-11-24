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

/**
 * The disc behind a buddy: a soft wash of the Bot's own colour, so it stays its colour everywhere. No
 * outline: on the dark page a light ring read as a white border around the character. A bare buddy
 * has no disc at all, and stands on the page.
 */
function discStyle(seed: string, size: number, bare: boolean): CSSProperties {
  const { c1 } = orbPalette(seed);
  return {
    "--buddy-bg": bare
      ? "transparent"
      : `color-mix(in oklab, ${c1} 22%, var(--background))`,
    "--buddy-border": "transparent",
    height: size,
    width: size,
  } as CSSProperties;
}

/** The box a buddy's picture or clip fills: its disc, or nothing where it stands bare. */
function frameClass(bare: boolean): string {
  return bare
    ? "relative block"
    : "relative block overflow-hidden rounded-full bg-(--buddy-bg)";
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
  bare = false,
}: {
  seed: string;
  name: string;
  size?: number;
  activity?: BuddyActivity;
  /** Draw this buddy instead of the Bot's own, as the picker previews one. */
  buddy?: DrawnBuddy;
  /** Its still picture whatever the Bot is doing, as where something covers it. */
  still?: boolean;
  /** No disc: the character alone, standing on the page. */
  bare?: boolean;
}) {
  const own = useBotBuddy(seed);
  const buddy = given ?? own;
  const reduceMotion = useReducedMotion();
  // A buddy with no clips (one only drawn, where nothing could animate it) is always its picture.
  const still =
    keepStill ||
    reduceMotion ||
    Object.keys(buddy.clips).length === 0 ||
    (size <= STILL_MAX_SIZE && activity === "idle");

  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0"
      data-buddy={buddy.key}
      style={discStyle(seed, size, bare)}
    >
      <span aria-hidden="true" className="contents">
        {still ? (
          <BuddyStill bare={bare} buddy={buddy} size={size} />
        ) : (
          <BuddyLive
            activity={activity}
            bare={bare}
            buddy={buddy}
            size={size}
          />
        )}
      </span>
    </span>
  );
}

function BuddyStill({
  buddy,
  size,
  bare,
}: {
  buddy: DrawnBuddy;
  size: number;
  bare: boolean;
}) {
  return (
    <span className={frameClass(bare)} style={{ height: size, width: size }}>
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

/**
 * Whether the page is drawn by WebKit: Safari, and the window OpenBot Desktop draws on a Mac. WebKit
 * draws a WebM clip's transparency as black, so a buddy plays its HEVC copies there instead.
 */
function isWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent;
  return (
    /AppleWebKit/.test(agent) &&
    !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|Android/.test(agent)
  );
}

const WEBKIT = isWebKit();

function BuddyLive({
  buddy,
  size,
  activity,
  bare,
}: {
  buddy: DrawnBuddy;
  size: number;
  activity: BuddyActivity;
  bare: boolean;
}) {
  if (WEBKIT)
    return (
      <BuddyWebKit activity={activity} bare={bare} buddy={buddy} size={size} />
    );
  return <BuddyRenderer activity={activity} buddy={buddy} size={size} />;
}

/**
 * A buddy's pose in WebKit: the clip's HEVC copy, with the still picture as its poster, so where
 * there is no copy (a stock buddy built off a Mac, or the person's own transparent one) the picture
 * shows instead of a black box. The person's own opaque clips play as they are.
 */
function BuddyWebKit({
  buddy,
  size,
  activity,
  bare,
}: {
  buddy: DrawnBuddy;
  size: number;
  activity: BuddyActivity;
  bare: boolean;
}) {
  const pose = poseFor(buddy, activity);
  const clip = pose
    ? (buddy.webkitClips?.[pose] ?? buddy.clips[pose])
    : undefined;
  return (
    <span className={frameClass(bare)} style={{ height: size, width: size }}>
      {clip ? (
        <video
          autoPlay
          className="size-full object-cover"
          key={clip}
          loop
          muted
          playsInline
          poster={buddy.avatarUrl}
          preload="auto"
        >
          <source
            src={clip}
            type={
              clip.endsWith(".hevc.mp4")
                ? 'video/mp4; codecs="hvc1"'
                : undefined
            }
          />
        </video>
      ) : (
        <img
          alt=""
          className="size-full object-cover"
          draggable={false}
          src={buddy.avatarUrl}
        />
      )}
    </span>
  );
}

function BuddyRenderer({
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
