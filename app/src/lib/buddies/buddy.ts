import type { OwnBuddy } from "./queries";
import { STOCK_BUDDIES, STOCK_POSES, type StockBuddy } from "./stock";

/** A buddy ready to draw: its still picture and a clip per pose it has. */
export type DrawnBuddy = {
  /** `stock:<id>` or `own:<id>`, as a Bot's buddy names it. */
  key: string;
  name: string;
  avatarUrl: string;
  clips: Record<string, string>;
  /**
   * Each clip's transparent HEVC copy, for WebKit, which draws a WebM clip's transparency as black.
   * Only stock buddies have them, and only where the app was built on a Mac
   * (scripts/fetch-stock-buddies.ts); a missing one shows the still picture.
   */
  webkitClips?: Record<string, string>;
};

/** What a Bot is doing, as the pose its buddy plays. */
export type BuddyActivity =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "done"
  | "talking"
  | "error";

/**
 * The pose each activity plays, then what to play when the buddy has no clip for it. A buddy a person
 * made has only the core poses, and one being made may have fewer still.
 */
const POSE_FOR: Record<BuddyActivity, readonly string[]> = {
  idle: ["idle"],
  thinking: ["thinking", "working", "idle"],
  working: ["working", "thinking", "idle"],
  waiting: ["asking", "listening", "idle"],
  done: ["done", "talking", "idle"],
  talking: ["talking", "idle"],
  error: ["error", "idle"],
};

export function poseFor(
  buddy: DrawnBuddy,
  activity: BuddyActivity,
): string | null {
  for (const pose of POSE_FOR[activity]) if (buddy.clips[pose]) return pose;
  return null;
}

export function stockBuddy(stock: StockBuddy): DrawnBuddy {
  const base = `/buddies/${stock.id}`;
  return {
    key: `stock:${stock.id}`,
    name: stock.name,
    avatarUrl: `${base}/avatar.png`,
    clips: Object.fromEntries(
      STOCK_POSES.map((pose) => [pose, `${base}/${pose}.webm`]),
    ),
    webkitClips: Object.fromEntries(
      STOCK_POSES.map((pose) => [pose, `${base}/${pose}.hevc.mp4`]),
    ),
  };
}

/** A buddy the person made, once its picture exists. */
export function ownBuddy(own: OwnBuddy): DrawnBuddy | null {
  if (!own.avatarUrl) return null;
  return {
    key: `own:${own.id}`,
    name: own.name,
    avatarUrl: own.avatarUrl,
    clips: { ...own.poses },
  };
}

/**
 * The buddy a Bot is drawn as, for the person looking: the one they chose for it. A buddy is opt in,
 * so a Bot nobody chose one for has none, and neither has one whose choice names a stock buddy this
 * app doesn't ship or one of the person's own that is gone or not drawn yet.
 */
export function buddyFor(
  choice: string | null | undefined,
  own: readonly OwnBuddy[] | undefined,
): DrawnBuddy | null {
  if (choice?.startsWith("stock:")) {
    const stock = STOCK_BUDDIES.find((buddy) => `stock:${buddy.id}` === choice);
    return stock ? stockBuddy(stock) : null;
  }
  if (choice?.startsWith("own:")) {
    const made = own?.find((buddy) => `own:${buddy.id}` === choice);
    return made ? ownBuddy(made) : null;
  }
  return null;
}
