import {
  KITE_PATTERNS,
  type KitePattern,
  OPENBOT_PATTERN,
  OPENBOT_SLOT,
} from "./kite-draw";

/** How one Bot is told apart from the others: its colour, its sail pattern and its blink. */
export type BotLivery = {
  /** Colour slot, 0..7 in `KITE_COLORS` order. */
  slot: number;
  pattern: KitePattern;
  /** Seeds its blink schedule and how its eyes fly in, so a team never blinks in unison. */
  seed: number;
};

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** No seed has no identity to keep: the first colour, a plain sail. */
const NO_SEED: BotLivery = { slot: 0, pattern: "solid", seed: 1 };

/**
 * A Bot's livery, from its seed (`avatarSeed`, the Bot's id unless set). Never from its name, so
 * renaming a Bot keeps its look.
 *
 * The colour is the 32-bit FNV-1a hash of the seed modulo eight, exactly as the orb picked its
 * palette, so every Bot keeps the colour it had. The pattern comes from bits 16 to 18 of the same
 * hash, so it varies independently of the colour; of the bits tried, these are the ones that give
 * every Bot the repo ships a livery of its own (`tests/kite-livery.test.ts`).
 */
export function botLivery(seed: string): BotLivery {
  if (!seed) return NO_SEED;
  let hash = FNV_OFFSET;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  const h = hash >>> 0;
  const slot = h % 8;
  let pick = (h >>> 16) % KITE_PATTERNS.length;
  // Violet quarters is OpenBot's own kite. One Bot in 64 would land on it and read as the product,
  // so that Bot takes the next sail instead, keeping its colour.
  if (slot === OPENBOT_SLOT && KITE_PATTERNS[pick] === OPENBOT_PATTERN)
    pick = (pick + 1) % KITE_PATTERNS.length;
  return {
    slot,
    pattern: KITE_PATTERNS[pick],
    seed: (h % 9973) + 1,
  };
}
