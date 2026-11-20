/** The colors `AgentOrb` draws with: a ground and four mesh stops. */
export type OrbColors = {
  bg: string;
  c1: string;
  c2: string;
  c3: string;
  c4: string;
};

/*
 * The orb's ground is the page's own background, so the dot pattern laid over the mesh is the
 * surface's color in light and in dark.
 */
const BG = "var(--background)";

/**
 * Eight palettes, all inside the CopilotKit family: mint, violet, periwinkle, sky, orange, red,
 * lilac and teal. The order is part of the contract: a Bot's color is its index here, so
 * reordering or inserting would recolor every Bot.
 */
export const ORB_PALETTES: readonly OrbColors[] = [
  { bg: BG, c1: "#23d5a2", c2: "#1fbf92", c3: "#7480f1", c4: "#85ecce" },
  { bg: BG, c1: "#8dc1f1", c2: "#686fdf", c3: "#4b4fb8", c4: "#a9aef8" },
  { bg: BG, c1: "#8dc1f1", c2: "#7480f1", c3: "#686fdf", c4: "#a9aef8" },
  { bg: BG, c1: "#23d5a2", c2: "#8dc1f1", c3: "#5e8fd9", c4: "#a9c9f5" },
  { bg: BG, c1: "#7480f1", c2: "#ffac4d", c3: "#e8894a", c4: "#ffd36b" },
  { bg: BG, c1: "#ffac4d", c2: "#fa5f67", c3: "#686fdf", c4: "#ff9aa0" },
  { bg: BG, c1: "#bec2ff", c2: "#9aa3ff", c3: "#7480f1", c4: "#b3a6f5" },
  { bg: BG, c1: "#8dc1f1", c2: "#23d5a2", c3: "#189370", c4: "#85ecce" },
];

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * A Bot's palette, from its seed (`avatarSeed`, the Bot's id unless set). Never from its name, so
 * renaming a Bot keeps its color. A 32-bit FNV-1a hash spreads similar ids across the eight.
 */
export function orbPalette(seed: string): OrbColors {
  // No seed has no identity to keep, so it gets the first palette rather than whatever the hash of
  // nothing happens to land on.
  if (!seed) return ORB_PALETTES[0];
  let hash = FNV_OFFSET;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return ORB_PALETTES[(hash >>> 0) % ORB_PALETTES.length];
}
