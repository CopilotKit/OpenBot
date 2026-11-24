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

/** A string's hash, the same in every browser, so a Bot gets the same stock buddy everywhere. */
function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** The stock buddy a Bot gets until somebody chooses one, picked from its seed. */
export function automaticBuddy(seed: string): DrawnBuddy {
  return stockBuddy(STOCK_BUDDIES[hash(seed) % STOCK_BUDDIES.length]);
}

/**
 * The buddy a Bot is drawn as: the one the person chose, or its automatic one. A choice naming a
 * stock buddy this app doesn't ship, or one of the person's own that is gone, draws the automatic one.
 */
export function buddyFor(
  seed: string,
  choice: string | null | undefined,
  own: readonly OwnBuddy[] | undefined,
): DrawnBuddy {
  if (choice?.startsWith("stock:")) {
    const stock = STOCK_BUDDIES.find((buddy) => `stock:${buddy.id}` === choice);
    if (stock) return stockBuddy(stock);
  }
  if (choice?.startsWith("own:")) {
    const made = own?.find((buddy) => `own:${buddy.id}` === choice);
    const drawn = made ? ownBuddy(made) : null;
    if (drawn) return drawn;
  }
  return automaticBuddy(seed);
}
