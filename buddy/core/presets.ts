// The fixed catalog of animated-background and effect presets (§2 of the spec).
// Heterogeneous by design: one layer API over several engines — procedural
// particles, canvas painters, CSS, and macros that expand to multiple layers.
import type {
  BuddyLayer,
  BuddyPresetId,
  LayerAnchor,
  LayerBlend,
  LayerSlot,
} from "./types.ts";

export type PresetEngine = "particles" | "painter" | "css" | "glyphs" | "macro";

export type BuddyPreset = {
  id: string;
  label: string;
  kind: "background" | "effect";
  engine: PresetEngine;
  /** Default slot for the resolved layer(s). */
  slot: LayerSlot;
  anchor?: LayerAnchor;
  height?: number;
  blend?: LayerBlend;
  /** Engine config (particle params / painter id / glyph set…) — narrowed inside
   *  each engine, never by callers. */
  config: Record<string, unknown>;
  /** For macros: the layers this preset expands to (one level deep). */
  expand?: Array<BuddyLayer>;
};

// ---- particle palettes -----------------------------------------------------
const WHITE = ["#ffffff", "#e8f0ff"];
const GOLD = ["#fff6c8", "#ffd54a", "#ffffff"];
const FIRE = ["#fff2b0", "#ffb648", "#ff7a1a", "#ff4d00"];
const CONFETTI = ["#ff5d73", "#ffd04a", "#4ad6a8", "#5aa9ff", "#c07bff"];
const PINK = ["#ff8fb3", "#ff5d8f", "#ffd0e0"];
const BOKEH = ["#ff9ecb", "#9ec8ff", "#b0ffd9", "#ffe3a1", "#c7a9ff"];
const WARM = ["#fff2a8", "#ffd86b"];

// Particle config defaults the engine reads; omitted keys fall back in-engine.
type P = Record<string, unknown>;
const particles = (
  id: string,
  label: string,
  kind: "background" | "effect",
  slot: LayerSlot,
  config: P,
  extra: Partial<BuddyPreset> = {},
): BuddyPreset => ({
  id,
  label,
  kind,
  engine: "particles",
  slot,
  config,
  ...extra,
});

const painter = (
  id: string,
  label: string,
  kind: "background" | "effect",
  painterId: string,
): BuddyPreset => ({
  id,
  label,
  kind,
  engine: "painter",
  slot: "backdrop",
  config: { painter: painterId },
});

// ---- internal macro sub-presets (ids prefixed `__`, not listed publicly) ---
const INTERNAL: Array<BuddyPreset> = [
  painter("__underwater", "Underwater", "background", "underwater"),
  particles("__bubbles-bg", "Bubbles", "background", "backdrop", {
    shape: "bubble",
    colors: ["#dff6ff", "#bfe9ff"],
    count: 10,
    spawn: "bottom",
    vy: [-26, -14],
    sway: { amp: 6, freq: 0.6 },
    size: [3, 9],
    opacity: 0.5,
    fadeTop: true,
  }),
  painter("__forest-dapple", "Forest Dapple", "background", "forest-dapple"),
  particles("__dapple", "Dapple", "background", "backdrop", {
    shape: "circle",
    colors: ["#fff3c0", "#eaffba"],
    count: 16,
    spawn: "full",
    randomWalk: true,
    speed: 0.4,
    size: [6, 16],
    opacity: 0.35,
    soft: true,
    twinkle: 0.4,
  }),
  // disco ball: CSS/SVG, hung from the top; dapples sweep the front.
  {
    id: "__disco-ball",
    label: "Disco Ball",
    kind: "effect",
    engine: "css",
    slot: "behind",
    anchor: "top",
    height: 0.3,
    config: { variant: "disco-ball" },
  },
  particles("__disco-dapples", "Disco Dapples", "effect", "front", {
    shape: "circle",
    colors: ["#ffd1f5", "#c8f0ff", "#fff0b8"],
    count: 16,
    spawn: "full",
    randomWalk: true,
    speed: 0.7,
    size: [5, 12],
    opacity: 0.35,
    soft: true,
    twinkle: 0.6,
  }),
  // fireflies share one config across two slots (density set by the macro).
  particles("__firefly", "Fireflies", "effect", "behind", {
    shape: "circle",
    colors: WARM,
    count: 10,
    spawn: "full",
    randomWalk: true,
    speed: 0.5,
    size: [2, 4],
    glow: true,
    twinkle: 0.8,
    composite: "lighter",
  }),
];

// ---- backgrounds (§2.1, slot backdrop, cover) ------------------------------
export const BACKGROUND_PRESETS: Array<BuddyPreset> = [
  painter("aurora", "Aurora Sky", "background", "aurora"),
  particles("starfield", "Starfield Drift", "background", "backdrop", {
    shape: "circle",
    colors: WHITE,
    count: 70,
    spawn: "full",
    vx: [-14, -5],
    size: [0.6, 2.2],
    twinkle: 0.7,
    base: "#060a1e",
  }),
  painter("nebula", "Nebula", "background", "nebula"),
  painter("sunset-clouds", "Sunset Clouds", "background", "sunset-clouds"),
  {
    id: "underwater",
    label: "Underwater",
    kind: "background",
    engine: "macro",
    slot: "backdrop",
    config: {},
    expand: [{ preset: "__underwater" }, { preset: "__bubbles-bg" }],
  },
  painter("synthwave", "Synthwave Horizon", "background", "synthwave"),
  painter("rainy-window", "Rainy Window", "background", "rainy-window"),
  {
    id: "forest-dapple",
    label: "Forest Dapple",
    kind: "background",
    engine: "macro",
    slot: "backdrop",
    config: {},
    expand: [{ preset: "__forest-dapple" }, { preset: "__dapple" }],
  },
  particles("bokeh", "Bokeh Lights", "background", "backdrop", {
    shape: "circle",
    colors: BOKEH,
    count: 14,
    spawn: "full",
    randomWalk: true,
    speed: 0.3,
    size: [18, 46],
    opacity: 0.25,
    soft: true,
    base: "#141026",
  }),
  painter("ocean", "Ocean Shimmer", "background", "ocean"),
];

// ---- effects (§2.2, default slot per preset) -------------------------------
export const EFFECT_PRESETS: Array<BuddyPreset> = [
  particles("sparkles", "Magic Sparkles", "effect", "front", {
    shape: "star",
    colors: GOLD,
    count: 28,
    spawn: "full",
    vy: [6, 20],
    sway: { amp: 8, freq: 0.5 },
    size: [3, 8],
    twinkle: 0.9,
    rotate: true,
    composite: "lighter",
  }),
  particles(
    "flames",
    "Flames",
    "effect",
    "front",
    {
      shape: "flake",
      colors: FIRE,
      count: 54,
      spawn: "bottom",
      vy: [-90, -50],
      sway: { amp: 7, freq: 1.4 },
      size: [4, 12],
      flicker: 0.8,
      composite: "lighter",
      fadeTop: true,
    },
    { anchor: "bottom", height: 0.35 },
  ),
  {
    id: "disco",
    label: "Disco Ball",
    kind: "effect",
    engine: "macro",
    slot: "front",
    config: {},
    expand: [{ preset: "__disco-ball" }, { preset: "__disco-dapples" }],
  },
  particles("confetti", "Confetti", "effect", "front", {
    shape: "rect",
    colors: CONFETTI,
    count: 40,
    spawn: "top",
    vy: [26, 60],
    gravity: 14,
    sway: { amp: 14, freq: 0.7 },
    size: [4, 9],
    rotate: true,
  }),
  particles("snow", "Snowfall", "effect", "front", {
    shape: "flake",
    colors: WHITE,
    count: 44,
    spawn: "top",
    vy: [12, 34],
    sway: { amp: 16, freq: 0.5 },
    size: [1.5, 4],
    opacity: 0.9,
  }),
  particles("rain", "Gentle Rain", "effect", "front", {
    shape: "streak",
    colors: ["#bcd4ff", "#9fb8e8"],
    count: 70,
    spawn: "top",
    vy: [220, 320],
    size: [6, 12],
    opacity: 0.35,
  }),
  {
    id: "fireflies",
    label: "Fireflies",
    kind: "effect",
    engine: "macro",
    slot: "front",
    config: {},
    expand: [
      { preset: "__firefly", slot: "behind", density: 0.6 },
      { preset: "__firefly", slot: "front", density: 0.4 },
    ],
  },
  particles("hearts", "Rising Hearts", "effect", "front", {
    shape: "heart",
    colors: PINK,
    count: 16,
    spawn: "bottom",
    vy: [-46, -24],
    sway: { amp: 12, freq: 0.8 },
    size: [8, 16],
    fadeTop: true,
  }),
  particles("bubbles", "Bubbles", "effect", "front", {
    shape: "bubble",
    colors: ["#dff6ff", "#bfe9ff", "#ffffff"],
    count: 18,
    spawn: "bottom",
    vy: [-54, -30],
    sway: { amp: 10, freq: 0.9 },
    size: [4, 13],
    fadeTop: true,
  }),
  {
    id: "glyphs-z",
    label: "Sleep Zzz",
    kind: "effect",
    engine: "glyphs",
    slot: "front",
    anchor: "top",
    config: { glyphs: ["Z", "z"], colors: ["#cfe0ff", "#9fb8e8"] },
  },
  {
    id: "glyphs-music",
    label: "Music Notes",
    kind: "effect",
    engine: "glyphs",
    slot: "front",
    anchor: "top",
    config: {
      glyphs: ["♪", "♫", "♩"],
      colors: ["#ffd36b", "#ff9ecb", "#9ec8ff"],
    },
  },
];

export const ALL_PRESETS: Array<BuddyPreset> = [
  ...BACKGROUND_PRESETS,
  ...EFFECT_PRESETS,
  ...INTERNAL,
];

const BY_ID = new Map(ALL_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): BuddyPreset | undefined {
  return BY_ID.get(id);
}

/** The public (non-internal) preset ids, for validation/UI. */
export const PUBLIC_PRESET_IDS = new Set<string>(
  [...BACKGROUND_PRESETS, ...EFFECT_PRESETS].map((p) => p.id as BuddyPresetId),
);
