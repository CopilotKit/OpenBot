import { KITE_PATTERNS, type KitePattern } from "./kite-draw";

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
 * palette, so every Bot keeps the colour it had. The pattern comes from the hash's next three bits,
 * so it varies independently of the colour.
 */
export function botLivery(seed: string): BotLivery {
  if (!seed) return NO_SEED;
  let hash = FNV_OFFSET;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  const h = hash >>> 0;
  return {
    slot: h % 8,
    pattern: KITE_PATTERNS[Math.floor(h / 8) % KITE_PATTERNS.length],
    seed: (h % 9973) + 1,
  };
}
