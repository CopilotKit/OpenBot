/*
 * OpenBot's mascot, the Pro pixel kite: a sharp kite with no rounded corners that sleeps with no
 * face and wakes with pixel eyes.
 *
 * The numbers are the mascot spec's, the same ones its reference renderer (`livery.js`) draws with
 * for openbot.co and the launch video, so a Bot looks the same in the app as everywhere else. Only
 * the picked look is here (Filled, pixel eyes, a face only at contact): the spec's other
 * silhouettes, the outline body, the rounded eyes and the always-awake face are not.
 *
 * Everything is a pure function of time and a per-Bot seed. Units: a Bot's slot is 1 × 1, centred
 * on (0, 0), and `S` is the slot's size in CSS px.
 */

/** What a Bot is doing, as the mascot draws it. */
export type KiteState =
  | "sleeping"
  | "idle"
  | "listening"
  | "thinking"
  | "streaming"
  | "waiting"
  | "done"
  | "error";

export const KITE_STATES: readonly KiteState[] = [
  "sleeping",
  "idle",
  "listening",
  "thinking",
  "streaming",
  "waiting",
  "done",
  "error",
];

/** Each state in the words the product uses for it. */
export const KITE_STATE_LABEL: Record<KiteState, string> = {
  sleeping: "Sleeping",
  idle: "Idle",
  listening: "Listening",
  thinking: "Working",
  streaming: "Answering",
  waiting: "Waiting for you",
  done: "Done",
  error: "Error",
};

/**
 * The eight Bot colours, from CopilotKit's brand, each with a lifted twin for a dark ground so all
 * sixteen clear 3:1. The order is the contract: a Bot's colour is its slot here, the same slot its
 * seed picked for the orb, so no Bot changes colour. Violet is OpenBot's own.
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

/** OpenBot's own colour: the kite that stands for the product rather than one Bot. */
export const OPENBOT_SLOT = 1;

/** A Bot's sail pattern, painted in a lighter tone of its own colour. */
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

/** The status dot's reserved system colours. Idle and sleeping have no dot. */
export const KITE_STATUS: Partial<Record<KiteState, string>> = {
  listening: "#2f6fed",
  thinking: "#2f6fed",
  streaming: "#2f6fed",
  waiting: "#d99a06",
  done: "#1f9d55",
  error: "#dc3d3d",
};

/** The face shows only at moments of contact with the person. */
const FACE: Partial<Record<KiteState, true>> = {
  listening: true,
  streaming: true,
  waiting: true,
  done: true,
};

export const faceOn = (state: KiteState) => FACE[state] === true;

/** At this size and under the body never moves: only the status dot does. */
export const STILL_MAX = 32;
/** Under this size there is no face at all, and the status dot carries the state. */
export const FACE_MIN = 22;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function bezier(x1: number, y1: number, x2: number, y2: number) {
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let u = x;
    for (let i = 0; i < 24; i++) {
      u = (lo + hi) / 2;
      const bx =
        3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
      if (bx < x) lo = u;
      else hi = u;
    }
    return (
      3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u
    );
  };
}
/** The operator ease: fast out, a long soft landing, no overshoot. */
export const easeOut = bezier(0.2, 0, 0, 1);
const easeIn = bezier(0.4, 0, 1, 1);

const hexRgb = (h: string) => {
  const n = Number.parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a: string, b: string, t: number) => {
  const A = hexRgb(a);
  const B = hexRgb(b);
  return `#${A.map((v, i) =>
    Math.round(v + (B[i] - v) * t)
      .toString(16)
      .padStart(2, "0"),
  ).join("")}`;
};
const rgba = (h: string, a: number) => {
  const c = hexRgb(h);
  return `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;
};

// ---------- the silhouette ----------

type Point = readonly [number, number];

/*
 * A tangential kite: upright and symmetrical, square in its bounds, with the cross spar at 0.4 of
 * its height from the nose. The face sits in its incircle, the circle touching all four edges.
 * Corner radii are 0 and joins are mitred: Pro is sharp.
 */
const KITE = (() => {
  const H = 0.9;
  const W = H;
  const top = -H / 2;
  const a = W / 2;
  const c = 0.4 * H;
  const cy = top + c;
  const s1 = Math.hypot(a, c);
  const s2 = Math.hypot(a, H - c);
  const y0 = (H * s1) / (s1 + s2);
  const r = (a * y0) / s1;
  return {
    W,
    H,
    T: [0, top] as Point,
    R: [a, cy] as Point,
    B: [0, top + H] as Point,
    L: [-a, cy] as Point,
    X: [0, cy] as Point,
    face: [0, top + y0 + 0.2 * r] as Point,
    dot: [0.36, 0.34] as Point,
  };
})();

function bodyPath(): Path2D {
  const p = new Path2D();
  p.moveTo(KITE.T[0], KITE.T[1]);
  p.lineTo(KITE.R[0], KITE.R[1]);
  p.lineTo(KITE.B[0], KITE.B[1]);
  p.lineTo(KITE.L[0], KITE.L[1]);
  p.closePath();
  return p;
}

function tri(ctx: CanvasRenderingContext2D, a: Point, b: Point, c: Point) {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.lineTo(c[0], c[1]);
  ctx.closePath();
  ctx.fill();
}

const PANELS = {
  TL: [KITE.T, KITE.X, KITE.L],
  TR: [KITE.T, KITE.R, KITE.X],
  BL: [KITE.L, KITE.X, KITE.B],
  BR: [KITE.X, KITE.R, KITE.B],
} as const;
const PANEL_SETS: Partial<Record<KitePattern, (keyof typeof PANELS)[]>> = {
  quarters: ["TR", "BL"],
  top: ["TL", "TR"],
  left: ["TL", "BL"],
  bottom: ["BL", "BR"],
  "cross-quarters": ["TL", "BR"],
};

function paintPattern(ctx: CanvasRenderingContext2D, pattern: KitePattern) {
  const { X, W, H } = KITE;
  for (const key of PANEL_SETS[pattern] ?? []) {
    const [a, b, c] = PANELS[key];
    tri(ctx, a, b, c);
  }
  if (pattern === "spine") ctx.fillRect(-0.075 * W, -H, 0.15 * W, 2 * H);
  if (pattern === "band") ctx.fillRect(-W, X[1] - 0.055 * H, 2 * W, 0.11 * H);
}

/** The Bot's colour, and the lighter tone its sail pattern is painted in. */
export function tones(slot: number, dark: boolean) {
  const color = KITE_COLORS[((slot % 8) + 8) % 8];
  const base = dark ? color.darkHex : color.hex;
  const graphite = color.name === "graphite";
  const light =
    graphite && dark
      ? mix(base, "#000000", 0.14)
      : mix(base, "#ffffff", graphite ? 0.16 : 0.2);
  return { base, light };
}

// ---------- motion ----------

/*
 * Where each state rests. `dy` is a body offset (a share of the slot); `gx` and `gy` are the gaze,
 * -1..1. A pixel-eyed Bot bobs but never tilts, so the rest poses carry no rotation. None of them
 * glances up and to the right: that glance is another mascot's, never OpenBot's.
 */
type Rest = { dy: number; gx: number; gy: number };
const REST: Record<KiteState, Rest> = {
  idle: { dy: 0, gx: 0, gy: 0 },
  listening: { dy: 0.008, gx: -0.5, gy: 0.45 },
  thinking: { dy: 0, gx: 0, gy: 0 },
  streaming: { dy: 0, gx: -0.55, gy: 0.5 },
  waiting: { dy: 0, gx: 0, gy: 0 },
  done: { dy: 0, gx: 0, gy: 0.12 },
  error: { dy: 0.016, gx: 0, gy: 0 },
  sleeping: { dy: 0, gx: 0, gy: 0 },
};

/** A Bot's pose at one moment: how far it has moved, where it looks and how awake it is. */
export type KitePose = Rest & {
  state: KiteState;
  prev: KiteState;
  /** Seconds since the state last changed. */
  since: number;
  /** How formed the pixel eyes are, 0..1: 0.7 s to wake, 0.5 s to fall asleep. */
  wake: number;
  /** 1 open, 0 shut. */
  blink: number;
  /** How far the status dot has grown in, 0..1. */
  dotIn: number;
  /** A designed still rather than a moment of motion. */
  still: boolean;
};

/** When each state began, oldest first. The first entry's time is before the clock started. */
export type KiteTimeline = readonly { s: KiteState; t: number }[];

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The blink schedule repeats after this many seconds, so a page left open keeps blinking. */
const BLINK_SPAN = 400;
const blinkCache = new Map<number, number[]>();

/**
 * Each Bot blinks on its own seeded schedule, every 3–7 s and sometimes twice: 70 ms to close,
 * 35 ms shut, 120 ms to open. A team never blinks in unison.
 */
export function blinkAt(seed: number, time: number): number {
  let events = blinkCache.get(seed);
  if (!events) {
    const r = mulberry(seed * 7919 + 13);
    events = [];
    let x = 0.8 + r() * 2;
    while (x < BLINK_SPAN) {
      events.push(x);
      if (r() < 0.2) events.push(x + 0.3);
      x += 3 + r() * 4;
    }
    blinkCache.set(seed, events);
  }
  const t = time % BLINK_SPAN;
  let lid = 1;
  for (const b of events) {
    if (b > t) break;
    const u = t - b;
    if (u > 0.3) continue;
    lid = Math.min(
      lid,
      u < 0.07
        ? 1 - u / 0.07
        : u < 0.105
          ? 0
          : u < 0.225
            ? easeOut((u - 0.105) / 0.12)
            : 1,
    );
  }
  return lid;
}

function segment(timeline: KiteTimeline, t: number) {
  let i = 0;
  while (i + 1 < timeline.length && timeline[i + 1].t <= t) i++;
  return {
    s1: timeline[i].s,
    t1: timeline[i].t,
    s0: i > 0 ? timeline[i - 1].s : timeline[i].s,
  };
}

/**
 * The pose at time `t`: the outgoing state's rest blended into the new one over 0.26 s with the
 * operator ease, plus the new state's one gesture. Only waiting repeats a gesture.
 */
export function pose(
  timeline: KiteTimeline,
  t: number,
  seed: number,
): KitePose {
  const { s1, t1, s0 } = segment(timeline, t);
  const since = t - t1;
  const A = REST[s0];
  const B = REST[s1];
  const k = easeOut(clamp(since / 0.26, 0, 1));
  const f0 = faceOn(s0);
  const f1 = faceOn(s1);
  const P: KitePose = {
    state: s1,
    prev: s0,
    since,
    dy: lerp(A.dy, B.dy, k),
    gx: lerp(A.gx, B.gx, k),
    gy: lerp(A.gy, B.gy, k),
    // The pixels have to travel: 0.7 s to wake, 0.5 s to fall asleep.
    wake:
      f1 && f0
        ? 1
        : f1
          ? clamp(since / 0.7, 0, 1)
          : f0
            ? 1 - clamp(since / 0.5, 0, 1)
            : 0,
    blink: blinkAt(seed, t),
    dotIn: s0 === s1 ? 1 : easeOut(clamp(since / 0.2, 0, 1)),
    still: false,
  };
  if (s1 === "waiting") {
    const u = since % 4.8;
    const tug =
      u < 0.12
        ? easeIn(u / 0.12)
        : u < 0.44
          ? 1 - easeOut((u - 0.12) / 0.32)
          : 0;
    P.dy += 0.03 * tug;
  }
  if (s1 === "done") {
    const hop =
      since < 0.18
        ? easeOut(since / 0.18)
        : since < 0.52
          ? 1 - easeOut((since - 0.18) / 0.34)
          : 0;
    P.dy -= 0.045 * hop;
  }
  if (s1 === "streaming") {
    // It reads along the line it is writing: three quick saccades left to right, then back.
    const ph = since % 2.7;
    const step = Math.floor(ph / 0.9);
    const w = ph - step * 0.9;
    const from = step === 0 ? 0.55 : -0.55 + (step - 1) * 0.55;
    const to = -0.55 + step * 0.55;
    const gx =
      since < 0.9 && step === 0
        ? -0.55
        : lerp(from, to, easeOut(clamp(w / 0.09, 0, 1)));
    P.gx = lerp(A.gx, gx, k);
  }
  return P;
}

/** The designed still for each state: for reduced motion, and for a Bot at 32 px and under. */
export function stillPose(state: KiteState): KitePose {
  const awake = faceOn(state) ? 1 : 0;
  return {
    ...REST[state],
    state,
    prev: state,
    since: 99,
    wake: awake,
    blink: 1,
    dotIn: 1,
    still: true,
  };
}

/**
 * Whether a Bot drawn at `size` still has something to animate `since` seconds after its state
 * changed. False means its next frame is the same picture, so nothing needs to be drawn until the
 * state changes again.
 */
export function needsFrames(
  state: KiteState,
  size: number,
  since: number,
): boolean {
  // The wake, the fall asleep, the blend and the done hop are all over by then.
  if (since < 0.75) return true;
  // The dot keeps working's pulse and waiting's nudge at every size.
  if (state === "thinking" || state === "waiting") return true;
  // Above 32 px a face blinks, and an answering Bot reads along its line.
  return size > STILL_MAX && faceOn(state);
}

/**
 * The pose a Bot of `size` is drawn in at time `t`. Under reduced motion it is the state's still.
 * At 32 px and under the body and face hold that still too, and only the status dot moves: it grows
 * in on a change of state, pulses while working and nudges while waiting.
 */
export function poseAt(
  timeline: KiteTimeline,
  t: number,
  seed: number,
  size: number,
  reduced: boolean,
): KitePose {
  const live = pose(timeline, t, seed);
  if (reduced) return stillPose(live.state);
  if (size > STILL_MAX) return live;
  return {
    ...stillPose(live.state),
    since: live.since,
    dotIn: live.dotIn,
    still: false,
  };
}

// ---------- drawing ----------

/** Everything one frame of one Bot needs. */
export type KiteFrame = {
  /** The slot's size, in CSS px. */
  S: number;
  /** The slot's centre, in CSS px. Whole pixels keep the pixel eyes on their grid. */
  x: number;
  y: number;
  /** Colour slot, 0..7 in `KITE_COLORS` order. */
  slot: number;
  pattern: KitePattern;
  dark: boolean;
  pose: KitePose;
  /** Seeds where the eye pixels fly in from, so two Bots wake differently. */
  seed: number;
};

/**
 * How far past its slot, in CSS px on every side, a Bot draws: the status dot sits on the kite's
 * lower right and working's pulse grows past it.
 */
export function kiteBleed(S: number): number {
  const h = clamp(S * 0.075, 2.5, 12);
  const reach = KITE.dot[0] * S + 2.2 * h + Math.max(1, S * 0.012);
  return Math.ceil(Math.max(0, reach - S / 2)) + 1;
}

export function drawKite(ctx: CanvasRenderingContext2D, o: KiteFrame) {
  const { S } = o;
  const P = o.pose;
  const small = S <= STILL_MAX;
  const tn = tones(o.slot, o.dark);
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.save();
  // At 32 px and under the body never moves. A pixel-eyed Bot bobs but never tilts.
  if (!small) ctx.translate(0, P.dy * S);
  ctx.scale(S, S);
  const path = bodyPath();
  const face = pixelFace(P, S);
  ctx.save();
  if (P.state === "sleeping") ctx.globalAlpha *= 0.5;
  ctx.fillStyle = tn.base;
  ctx.fill(path);
  if (o.pattern !== "solid") {
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = tn.light;
    paintPattern(ctx, o.pattern);
    ctx.restore();
  }
  proTexture(ctx, path, S, tn.base);
  ctx.restore();
  drawPixels(ctx, face, S, eyeColor(tn.base), o.seed);
  ctx.restore();
  drawStatus(ctx, P, S);
  ctx.restore();
}

/*
 * Pro's material: a one-hue fall of light down the sail, the fine square weave of ripstop, and the
 * two spars in a deeper tone of the Bot's own colour. Each layer drops out as the Bot gets smaller,
 * so a 16 px Bot is a clean flat shape.
 */
function proTexture(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  S: number,
  base: string,
) {
  ctx.save();
  ctx.clip(path);
  const px = 1 / S;
  if (S >= 48) {
    const fall = ctx.createLinearGradient(0, KITE.T[1], 0, KITE.B[1]);
    fall.addColorStop(0, "rgba(255,255,255,0.08)");
    fall.addColorStop(0.55, "rgba(255,255,255,0)");
    fall.addColorStop(1, "rgba(0,0,0,0.1)");
    ctx.fillStyle = fall;
    ctx.fillRect(-1, -1, 2, 2);
  }
  if (S >= 64) {
    const step = S >= 140 ? 0.06 : 0.08;
    ctx.strokeStyle = "rgba(255,255,255,0.075)";
    ctx.lineWidth = px;
    ctx.beginPath();
    for (let v = -0.6; v <= 0.6; v += step) {
      ctx.moveTo(v, -0.6);
      ctx.lineTo(v, 0.6);
      ctx.moveTo(-0.6, v);
      ctx.lineTo(0.6, v);
    }
    ctx.stroke();
  }
  if (S >= 48) {
    const spar = mix(base, "#000000", 0.38);
    const X = KITE.X;
    ctx.strokeStyle = rgba(spar, 0.55);
    ctx.lineWidth = Math.max(px, 0.011);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(KITE.T[0], KITE.T[1]);
    ctx.lineTo(KITE.B[0], KITE.B[1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(KITE.L[0], KITE.L[1]);
    ctx.quadraticCurveTo(X[0], X[1] + 0.03, KITE.R[0], KITE.R[1]);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = rgba(mix(base, "#000000", 0.3), 0.35);
  ctx.lineWidth = px;
  ctx.lineJoin = "miter";
  ctx.stroke(path);
}

// ---------- the pixel face ----------

function hash2(a: number, b: number, seed: number): number {
  let h =
    (Math.imul(a, 374761393) +
      Math.imul(b, 668265263) +
      Math.imul(seed, 2246822519)) >>>
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** One "pixel" of the mascot, in CSS px, for a Bot drawn at size S. */
export const pixelPx = (S: number) => Math.max(1, Math.round(S * 0.055));

type Expression = "open" | "tall" | "blink" | "happy" | "flat";

/**
 * Which cells of the pixel grid are lit, as [column, row] from the face's centre. Open is 2×3 an
 * eye, waiting's tall is 2×4, a blink is one row and done is ^ ^. Gaze moves them a whole pixel.
 */
export function eyeCells(
  expr: Expression,
  dx: number,
  dy: number,
): [number, number][] {
  if (expr === "happy")
    return [
      [-3, 0],
      [-2, -1],
      [-1, 0],
      [1, 0],
      [2, -1],
      [3, 0],
    ];
  if (expr === "flat")
    return [
      [-3, 0],
      [-2, 0],
      [2, 0],
      [3, 0],
    ];
  let cells: [number, number][];
  if (expr === "blink")
    cells = [
      [-3, 1],
      [-2, 1],
      [2, 1],
      [3, 1],
    ];
  else if (expr === "tall")
    cells = [
      [-3, -2],
      [-2, -2],
      [-3, -1],
      [-2, -1],
      [-3, 0],
      [-2, 0],
      [-3, 1],
      [-2, 1],
      [2, -2],
      [3, -2],
      [2, -1],
      [3, -1],
      [2, 0],
      [3, 0],
      [2, 1],
      [3, 1],
    ];
  else
    cells = [
      [-3, -1],
      [-2, -1],
      [-3, 0],
      [-2, 0],
      [-3, 1],
      [-2, 1],
      [2, -1],
      [3, -1],
      [2, 0],
      [3, 0],
      [2, 1],
      [3, 1],
    ];
  return cells.map(([c, r]) => [c + dx, r + dy]);
}

type Face = {
  /** One mascot pixel, in slot units. */
  pu: number;
  fx: number;
  fy: number;
  cells: [number, number][];
  /** How formed the eyes are; 0 draws no face. */
  w: number;
};

/**
 * Where the pixel eyes land: one pixel above the incircle's face point, on the pixel grid, moved by
 * the gaze a whole pixel at a time (gaze only from 48 px). Under 22 px there is no face at all.
 */
export function pixelFace(P: KitePose, S: number): Face {
  const pu = pixelPx(S) / S;
  const fx = Math.round(KITE.face[0] * S) / S;
  const fy = Math.round((KITE.face[1] - pu) * S) / S;
  const q = (v: number) => clamp(Math.round(v * 1.3), -1, 1);
  const expressive = S >= 48;
  const expr: Expression =
    P.state === "done"
      ? "happy"
      : P.state === "error"
        ? "flat"
        : P.blink < 0.5
          ? "blink"
          : P.state === "waiting"
            ? "tall"
            : "open";
  const cells = eyeCells(
    expr,
    expressive ? q(P.gx) : 0,
    expressive ? q(P.gy) : 0,
  );
  return { pu, fx, fy, cells, w: S < FACE_MIN ? 0 : P.wake };
}

/**
 * The eyes form from pixels that fly in, staggered, and fade in as they land; falling asleep plays
 * the same backwards. Landed pixels overlap by most of a screen pixel, so a block has no seams.
 */
function drawPixels(
  ctx: CanvasRenderingContext2D,
  face: Face,
  S: number,
  eye: string,
  seed: number,
) {
  const { pu, fx, fy, cells, w } = face;
  if (w <= 0.001) return;
  ctx.save();
  const A0 = ctx.globalAlpha;
  ctx.fillStyle = eye;
  const n = cells.length;
  cells.forEach(([c, r], k) => {
    const dx = fx + c * pu;
    const dy = fy + r * pu;
    const sx = dx + (hash2(k, 3, seed) - 0.5) * pu * 6;
    const sy = dy + (hash2(k, 5, seed) - 0.5) * pu * 6;
    const p = easeOut(clamp((w - (k / n) * 0.35) / 0.55, 0, 1));
    const a = lerp(0, 1, p);
    if (a <= 0.01) return;
    const size = pu * lerp(0.78, 1, p) + (p >= 1 ? 0.9 / S : 0);
    ctx.globalAlpha = A0 * a;
    ctx.fillRect(
      lerp(sx, dx, p) - size / 2,
      lerp(sy, dy, p) - size / 2,
      size,
      size,
    );
  });
  ctx.restore();
}

/** White eyes on most bodies; near-black eyes on a light body, such as graphite on a dark ground. */
export function eyeColor(body: string): string {
  const c = hexRgb(body).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 0.45
    ? "#121216"
    : "#ffffff";
}

/*
 * Status lives in a small square beside the body, in reserved system colours, never in the body.
 * Listening is hollow, working sends out a square pulse, waiting nudges every 2 s.
 *
 * The reference paints a square of the page's colour around the dot to part it from the kite. A
 * Bot here sits on many grounds (a row, a hover, a card), so that square is cut out of the drawing
 * instead, and whatever is behind the Bot shows through it.
 */
function drawStatus(ctx: CanvasRenderingContext2D, P: KitePose, S: number) {
  const col = KITE_STATUS[P.state];
  if (!col) return;
  const x = KITE.dot[0] * S;
  const y = KITE.dot[1] * S;
  const h = clamp(S * 0.075, 2.5, 12) * P.dotIn;
  const ring = Math.max(1.3, S * 0.026);
  if (h < 0.3) return;
  let hh = h;
  if (P.state === "waiting" && !P.still) {
    const u = (P.since % 2) / 2;
    hh = h * (1 + 0.18 * Math.sin(Math.PI * clamp(u / 0.4, 0, 1)));
  }
  if (P.state === "thinking") {
    const u = P.still ? 0.45 : (P.since % 1.4) / 1.4;
    const e = hh * (1 + 1.2 * u);
    ctx.strokeStyle = rgba(col, P.still ? 0.35 : 0.55 * (1 - u));
    ctx.lineWidth = Math.max(1, S * 0.012);
    ctx.strokeRect(x - e, y - e, 2 * e, 2 * e);
  }
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000000";
  ctx.fillRect(x - hh - ring, y - hh - ring, 2 * (hh + ring), 2 * (hh + ring));
  ctx.restore();
  if (P.state === "listening") {
    const lw = Math.min(hh, Math.max(1.2, hh * 0.45));
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.strokeRect(x - hh + lw / 2, y - hh + lw / 2, 2 * hh - lw, 2 * hh - lw);
    return;
  }
  ctx.fillStyle = col;
  ctx.fillRect(x - hh, y - hh, 2 * hh, 2 * hh);
}
