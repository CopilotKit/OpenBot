import { paletteSlot, seedHash } from "@/lib/orb-palette";

/*
 * Kite Bot: a Bot drawn as a kite, one silhouette for every Bot, each in colours of its own (a colour
 * and a sail pattern). The Kite Bot skin draws Bots this way. Everything here is a pure function of the
 * Bot's seed and the size it is drawn at, so a Bot is the same kite wherever it appears.
 *
 * Units: a Bot's slot is 1 × 1, centred on (0, 0), which is the drawing's viewBox.
 */

export type Point = readonly [number, number];

/*
 * The kite: upright and symmetrical, as wide as it is tall, with the cross spar 40% of the way down
 * from the nose and crisp corners. The face sits in the kite's incircle, the circle touching all four
 * edges, a fifth of its radius below the centre.
 */
function kite(height: number, cross: number) {
  const top = -height / 2;
  const half = height / 2;
  const spar = cross * height;
  const crossY = top + spar;
  const upper = Math.hypot(half, spar);
  const lower = Math.hypot(half, height - spar);
  const centre = (height * upper) / (upper + lower);
  const radius = (half * centre) / upper;
  return {
    width: height,
    height,
    nose: [0, top] as Point,
    right: [half, crossY] as Point,
    tail: [0, top + height] as Point,
    left: [-half, crossY] as Point,
    cross: [0, crossY] as Point,
    face: [0, top + centre + 0.2 * radius] as Point,
    /** Where the status pixel sits, beside the body and never on it. */
    dot: [0.36, 0.34] as Point,
  };
}

export const KITE = kite(0.9, 0.4);

/** The kite's outline, as an SVG path. */
export const KITE_PATH = `M${KITE.nose.join(" ")}L${KITE.right.join(" ")}L${KITE.tail.join(" ")}L${KITE.left.join(" ")}Z`;

/*
 * Eight colours from CopilotKit's brand, in the same slot order as `orb-palette.ts`, so a Bot is the
 * same colour as a kite as it is as an orb. Each has a lifted twin for dark grounds, so all sixteen
 * clear 3:1 against the page. Red, amber, green and blue are left for status.
 */
export const KITE_COLORS = [
  { name: "mint", hex: "#189370", darkHex: "#2fb38b" },
  { name: "violet", hex: "#6430ab", darkHex: "#9265dd" },
  { name: "blue", hex: "#005dbb", darkHex: "#3d8ae6" },
  { name: "teal", hex: "#0e7c86", darkHex: "#22a6b0" },
  { name: "copper", hex: "#b4561a", darkHex: "#e07b3a" },
  { name: "raspberry", hex: "#a8325e", darkHex: "#d75c86" },
  { name: "plum", hex: "#7b2f7a", darkHex: "#b061ae" },
  { name: "graphite", hex: "#2b2b2b", darkHex: "#e9e9ef" },
] as const;

export type KiteColor = (typeof KITE_COLORS)[number];

/** Status colours, reserved: never a body's colour. */
export const KITE_STATUS = {
  working: "#2f6fed",
  waiting: "#d99a06",
} as const;

/*
 * The sail patterns, each painted in a lighter tone of the Bot's own colour. The quarters are the
 * four panels the spars divide the sail into.
 */
export const KITE_PATTERNS = [
  "solid",
  "quarters",
  "top",
  "left",
  "spine",
  "bottom",
  "band",
  "cross-quarters",
] as const;

export type KitePattern = (typeof KITE_PATTERNS)[number];

/** A Bot's colour, from the same slot as its orb. */
export function kiteColor(seed: string): KiteColor {
  return KITE_COLORS[paletteSlot(seed)];
}

/*
 * The colour is the seed's hash modulo eight, its low three bits. FNV-1a's low bits depend only on
 * the low bits before them, so a pattern taken the same way, even from the seed with something
 * appended, would follow the colour: every violet Bot would wear the same pattern. This finaliser
 * (MurmurHash3's) folds the high bits down into the low ones first.
 */
function scramble(hash: number): number {
  let h = hash ^ (hash >>> 16);
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A Bot's sail pattern, from its seed, independent of its colour, so two Bots of one colour usually
 * differ in pattern. No seed has no identity to keep, so it gets quarters, the pattern the kite was
 * drawn with.
 */
export function sailPattern(seed: string): KitePattern {
  if (!seed) return "quarters";
  return KITE_PATTERNS[scramble(seedHash(seed)) % KITE_PATTERNS.length];
}

export type Shape =
  | { kind: "polygon"; points: readonly Point[] }
  | { kind: "rect"; x: number; y: number; width: number; height: number };

/** The lighter panels of a pattern, to be clipped to the kite's outline. */
export function patternShapes(pattern: KitePattern): Shape[] {
  const { nose, right, tail, left, cross, width, height } = KITE;
  const panel = {
    topLeft: [nose, cross, left],
    topRight: [nose, right, cross],
    bottomLeft: [left, cross, tail],
    bottomRight: [cross, right, tail],
  } satisfies Record<string, readonly Point[]>;
  const panels: Partial<Record<KitePattern, (keyof typeof panel)[]>> = {
    quarters: ["topRight", "bottomLeft"],
    "cross-quarters": ["topLeft", "bottomRight"],
    top: ["topLeft", "topRight"],
    bottom: ["bottomLeft", "bottomRight"],
    left: ["topLeft", "bottomLeft"],
  };
  const chosen = panels[pattern];
  if (chosen) {
    return chosen.map((key) => ({ kind: "polygon", points: panel[key] }));
  }
  if (pattern === "spine") {
    return [
      {
        kind: "rect",
        x: -0.075 * width,
        y: -height,
        width: 0.15 * width,
        height: 2 * height,
      },
    ];
  }
  if (pattern === "band") {
    return [
      {
        kind: "rect",
        x: -width,
        y: cross[1] - 0.055 * height,
        width: 2 * width,
        height: 0.11 * height,
      },
    ];
  }
  return [];
}

const hexRgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** `a` moved toward `b` by `t`, as a hex colour. */
export function mix(a: string, b: string, t: number): string {
  const from = hexRgb(a);
  const to = hexRgb(b);
  return `#${from
    .map((v, i) =>
      Math.round(v + (to[i] - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function rgba(hex: string, alpha: number) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function luminance(hex: string) {
  const [r, g, b] = hexRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export type KiteTones = {
  body: string;
  panel: string;
  spar: string;
  edge: string;
  /** Solid, so the eyes read the same on a light page or a dark one. */
  eye: string;
};

/** The colours a kite is painted in, on a light page or a dark one. */
export function kiteTones(color: KiteColor, dark: boolean): KiteTones {
  const body = dark ? color.darkHex : color.hex;
  const graphite = color.name === "graphite";
  const panel =
    graphite && dark
      ? mix(body, "#000000", 0.14)
      : mix(body, "#ffffff", graphite ? 0.16 : 0.2);
  return {
    body,
    panel,
    spar: rgba(mix(body, "#000000", 0.38), 0.55),
    edge: rgba(mix(body, "#000000", 0.3), 0.35),
    // White eyes on most bodies; near-black on a light one, such as graphite on a dark page.
    eye: luminance(body) > 0.45 ? "#121216" : "#ffffff",
  };
}

/** The smallest a kite has a face at all: below it, a status pixel carries the state alone. */
export const FACE_MIN_SIZE = 22;
/** The smallest a kite is drawn with its spars and the light across its sail. */
export const DETAIL_MIN_SIZE = 48;
/** The smallest a kite is drawn with the fine square weave of ripstop. */
export const WEAVE_MIN_SIZE = 64;
/** At this size and under, the body never moves: only the status pixel does. */
export const STILL_MAX_SIZE = 32;

/** One pixel of the face, in the drawing's units, for a kite drawn `size` CSS pixels wide. */
export function pixelUnit(size: number): number {
  return Math.max(1, Math.round(size * 0.055)) / size;
}

/** `v` (in the drawing's units) moved onto the CSS pixel grid of a kite `size` pixels wide. */
function onGrid(v: number, size: number) {
  return Math.round((v + 0.5) * size) / size - 0.5;
}

export type Expression = "open" | "tall";

/**
 * The pixel eyes: two blocks, two pixels wide and three tall, a pixel's gap either side of the
 * centre column; four tall while the Bot waits on the person. `look` moves both by whole pixels.
 * Each cell carries its row before the look moved it, so the rows above the bottom one can close.
 */
export function eyeCells(
  expression: Expression,
  look: Point = [0, 0],
): { column: number; row: number; lid: boolean }[] {
  const rows = expression === "tall" ? [-2, -1, 0, 1] : [-1, 0, 1];
  const cells: { column: number; row: number; lid: boolean }[] = [];
  for (const column of [-3, -2, 2, 3]) {
    for (const row of rows) {
      cells.push({
        column: column + look[0],
        row: row + look[1],
        lid: row < 1,
      });
    }
  }
  return cells;
}

/** Where the face is drawn: a pixel above the incircle's centre, on the pixel grid. */
export function facePoint(size: number): Point {
  const unit = pixelUnit(size);
  return [onGrid(KITE.face[0], size), onGrid(KITE.face[1] - unit, size)];
}

/** The status pixel: its half-width, and the ring of page colour that cuts it out of the body. */
export function statusPixel(size: number) {
  return {
    half: Math.min(12, Math.max(2.5, size * 0.075)) / size,
    ring: Math.max(1.3, size * 0.026) / size,
  };
}

/**
 * A number in [0, 1) from a seed and a salt, for the details that vary per Bot: where each eye pixel
 * flies in from, and how often it blinks, so a team never blinks in unison.
 */
export function seeded(seed: string, salt: string): number {
  return seedHash(`${seed}:${salt}`) / 2 ** 32;
}
