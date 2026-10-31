/**
 * The orb, every Bot's face and OpenBot's own mark, drawn on a 2D canvas: a glass sphere of
 * drifting colour with two eye-lights that look, blink and smile. It comes in nine colours. A Bot's
 * look, its colour and the few small ways two Bots in one colour still differ, is picked from its
 * seed; OpenBot's own is violet, which no Bot is given. It also plays a finish: the check and the
 * burst of rays the orb shows when something the person allowed is done.
 *
 * Every frame is a pure function of an `OrbPose`, so the component that animates it owns time and
 * this file owns only the picture.
 */

const TAU = Math.PI * 2;
const PI = Math.PI;

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const eio = (u: number) => {
  const v = clamp(u);
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
};
const eout = (u: number) => 1 - (1 - clamp(u)) ** 3;
const smooth = (u: number) => {
  const v = clamp(u);
  return v * v * (3 - 2 * v);
};
const bump = (u: number) => (u <= 0 || u >= 1 ? 0 : Math.sin(PI * u) ** 2);

// ---------- motion: keyed tracks with eases and closed-form springs ----------

/** One move of a track: to `to` from time `at`, over an ease of `ease` seconds or on a spring of [stiffness, damping]. */
export type TrackKey =
  | { at: number; to: number; ease: number }
  | { at: number; to: number; spring: readonly [number, number] };

/** A value that starts at `from` and moves through its keys in order. */
export type Track = { from: number; keys: TrackKey[] };

/** Step response of a damped spring: closed form, so it is a pure function of elapsed time. */
function springStep(tau: number, w: number, z: number) {
  if (tau <= 0) return 0;
  if (z >= 1) return 1 - Math.exp(-w * tau) * (1 + w * tau);
  const wd = w * Math.sqrt(1 - z * z);
  return (
    1 -
    Math.exp(-z * w * tau) *
      (Math.cos(wd * tau) + ((z * w) / wd) * Math.sin(wd * tau))
  );
}

/**
 * The track's value at time t. Each key moves the value from the previous key's value to its own,
 * and the responses are summed, which for springs is exactly a spring chasing a stepped target:
 * anticipation, overshoot and settle all fall out of the same maths.
 */
export function track(tr: Track, t: number) {
  let v = tr.from;
  let prev = tr.from;
  for (const k of tr.keys) {
    if (t < k.at) break;
    const tau = t - k.at;
    const r =
      "ease" in k
        ? eio(tau / k.ease)
        : springStep(tau, k.spring[0], k.spring[1]);
    v += (k.to - prev) * r;
    prev = k.to;
  }
  return v;
}

/** A blink at `tau` seconds after it starts: shut fast, open slower, 0.24 s in all. */
export function blinkCurve(tau: number) {
  if (tau < 0 || tau > 0.24) return 0;
  return tau < 0.07 ? eout(tau / 0.07) : 1 - eio((tau - 0.07) / 0.17);
}

/** A nod that rings down, `tau` seconds after it starts. */
export function nodCurve(tau: number) {
  return tau >= 0 && tau < 2.2 ? Math.exp(-3 * tau) * Math.sin(8 * tau) : 0;
}

export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where it looks while nothing needs it: mostly at you, now and then a glance aside and back.
 * Each look snaps over 0.14 s and then holds, so the pauses are part of the motion.
 */
export function restLook(ta: number, period: number, seed: number) {
  const k = Math.floor(ta / period);
  const f = ta - k * period;
  const at = (n: number): [number, number, number] => {
    const r = mulberry32((seed * 7919 + n * 104729) | 0);
    return r() < 0.55
      ? [0, 0, 0]
      : [(r() * 2 - 1) * 0.7, (r() * 2 - 1) * 0.4, (r() * 2 - 1) * 0.24];
  };
  const a = at(k - 1);
  const b = at(k);
  const u = eout(f / 0.14);
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

// ---------- colour ----------

export type Rgb = [number, number, number];

function ok2rgb(L: number, C: number, h: number): Rgb | null {
  const hr = (h * PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const out: number[] = [];
  for (const x of linear) {
    if (x < -0.002 || x > 1.002) return null;
    const c = clamp(x);
    out.push(
      Math.round(
        255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055),
      ),
    );
  }
  return out as Rgb;
}

/** An oklch colour as sRGB, losing chroma until it fits rather than clipping its hue. */
export function oklch(L: number, C: number, h: number): Rgb {
  let chroma = C;
  for (let i = 0; i < 40; i++) {
    const c = ok2rgb(L, chroma, h);
    if (c) return c;
    chroma *= 0.95;
  }
  return ok2rgb(L, 0, h) ?? [128, 128, 128];
}

const rgba = (c: Rgb, a: number) =>
  `rgba(${c[0]},${c[1]},${c[2]},${a <= 0 ? 0 : a >= 1 ? 1 : a.toFixed(3)})`;
const mix = (a: Rgb, b: Rgb, u: number): Rgb => [
  Math.round(lerp(a[0], b[0], u)),
  Math.round(lerp(a[1], b[1], u)),
  Math.round(lerp(a[2], b[2], u)),
];
const WHITE: Rgb = [255, 255, 255];

type Oklch = readonly [L: number, C: number, h: number];

/**
 * One of the orb's colours, as oklch [L, C, h]: four tones for the sphere's drifting colour and its
 * pale base. `main` also tints its glow and, in the dark, the landing's ping and a finish's rays;
 * `deep` draws those in the light. `shade` is the tint of the sphere's shaded rim, as sRGB.
 */
type PaletteSpec = {
  main: Oklch;
  side: Oklch;
  deep: Oklch;
  pale: Oklch;
  base: Oklch;
  shade: readonly [r: number, g: number, b: number];
};

/**
 * The nine colours: violet, OpenBot's own, and the eight a Bot's look is picked from by position.
 * Adding, removing or reordering one changes the colour of most Bots. Each reads as one plain colour
 * even at 28px, where only its average shows (`orbSwatch`): purple, orange, green, yellow, pink,
 * blue, cyan, red and grey. Where two sit close on the wheel, lightness keeps them apart, and a
 * test holds every pair at least 0.08 apart in OKLab.
 */
const PALETTES = {
  violet: {
    main: [0.7, 0.14, 288],
    side: [0.72, 0.15, 318],
    deep: [0.47, 0.2, 296],
    pale: [0.86, 0.08, 308],
    base: [0.93, 0.03, 300],
    shade: [40, 16, 78],
  },
  ember: {
    main: [0.77, 0.17, 60],
    side: [0.73, 0.18, 52],
    deep: [0.6, 0.16, 50],
    pale: [0.86, 0.11, 66],
    base: [0.94, 0.05, 70],
    shade: [96, 44, 10],
  },
  moss: {
    main: [0.74, 0.17, 145],
    side: [0.78, 0.16, 130],
    deep: [0.55, 0.14, 150],
    pale: [0.88, 0.09, 140],
    base: [0.94, 0.04, 140],
    shade: [14, 60, 24],
  },
  sun: {
    main: [0.89, 0.17, 98],
    side: [0.91, 0.16, 106],
    deep: [0.77, 0.16, 92],
    pale: [0.95, 0.1, 104],
    base: [0.97, 0.05, 102],
    shade: [96, 76, 10],
  },
  berry: {
    main: [0.77, 0.17, 358],
    side: [0.75, 0.18, 350],
    deep: [0.57, 0.19, 358],
    pale: [0.88, 0.09, 352],
    base: [0.94, 0.04, 352],
    shade: [90, 14, 50],
  },
  ocean: {
    main: [0.63, 0.16, 252],
    side: [0.6, 0.17, 258],
    deep: [0.45, 0.2, 265],
    pale: [0.8, 0.08, 255],
    base: [0.9, 0.035, 255],
    shade: [14, 24, 90],
  },
  // Lighter and greener than ocean: a clear cyan against ocean's blue.
  sky: {
    main: [0.82, 0.12, 210],
    side: [0.85, 0.1, 195],
    deep: [0.64, 0.12, 220],
    pale: [0.92, 0.05, 205],
    base: [0.96, 0.025, 210],
    shade: [10, 50, 70],
  },
  // Darker than ember and pink, so red stands apart from both its neighbours.
  coral: {
    main: [0.63, 0.2, 30],
    side: [0.6, 0.21, 26],
    deep: [0.48, 0.19, 28],
    pale: [0.76, 0.13, 30],
    base: [0.9, 0.05, 28],
    shade: [90, 20, 16],
  },
  // Nearly grey: for a team big enough to want a quiet one.
  slate: {
    main: [0.64, 0.025, 250],
    side: [0.68, 0.02, 255],
    deep: [0.45, 0.03, 260],
    pale: [0.84, 0.012, 255],
    base: [0.91, 0.008, 258],
    shade: [30, 34, 44],
  },
} as const satisfies Record<string, PaletteSpec>;

export type OrbPaletteName = keyof typeof PALETTES;

/** Every colour, OpenBot's violet first. */
export const ORB_PALETTES = Object.keys(PALETTES) as readonly OrbPaletteName[];

/** The eight colours a Bot can be: all but violet, so a Bot is never mistaken for OpenBot. */
const BOT_PALETTES = ORB_PALETTES.filter((name) => name !== "violet");

/**
 * How one orb is drawn apart from its motion: its colour, how far round its colour masses are
 * turned, in radians, a nudge to its hue in degrees, and how far apart its eyes are, as a share of
 * the usual spacing.
 */
export type OrbLook = {
  palette: OrbPaletteName;
  turn: number;
  hue: number;
  eyes: number;
};

/** OpenBot's own look: violet, untouched. */
export const OPENBOT_LOOK: OrbLook = {
  palette: "violet",
  turn: 0,
  hue: 0,
  eyes: 1,
};

/** The most a Bot's hue is nudged either way, in degrees: a touch, never enough to pass for another colour. */
const HUE_NUDGE = 4;
/** The most a Bot's eyes are moved apart or together, as a share of the usual spacing. */
const EYE_NUDGE = 0.08;

/** A 32-bit FNV-1a hash of the seed, mixed with murmur3's finaliser so every character moves every bit. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The look for a Bot's seed. Eight colours repeat soon in a team, so the same hash also turns the
 * colour masses, nudges the hue and spaces the eyes, and two Bots in one colour still look apart.
 * Stable across reloads and releases, so a Bot keeps its face.
 */
export function orbLookFor(seed: string): OrbLook {
  const h = hashSeed(seed);
  // The hue, the eyes and the turn take a byte each, and the colour the top one. Of the ways to
  // share out the bits, this one draws the Bots OpenBot ships with in colours far apart, and turns
  // two catalog Bots in one colour well apart.
  const share = (from: number) => ((h >>> from) & 0xff) / 256;
  return {
    palette: BOT_PALETTES[(h >>> 24) % BOT_PALETTES.length] as OrbPaletteName,
    turn: share(16) * TAU,
    hue: Math.round((share(0) * 2 - 1) * HUE_NUDGE),
    eyes: 1 + (share(8) * 2 - 1) * EYE_NUDGE,
  };
}

/** A colour's tones as sRGB, ready to draw. */
export type Palette = Record<keyof PaletteSpec, Rgb>;
const paletteMemo = new Map<string, Palette>();

/** A colour with its saturation and hue nudged, as the orb livens when it listens and cools when it works. */
export function palette(
  name: OrbPaletteName,
  sat: number,
  hue: number,
): Palette {
  const ks = Math.round(clamp(sat, 0.5, 1.3) * 50) / 50;
  const kh = Math.round(hue * 2) / 2;
  const key = `${name}|${ks}|${kh}`;
  let p = paletteMemo.get(key);
  if (!p) {
    const spec: PaletteSpec = PALETTES[name];
    const c = ([L, C, h]: Oklch, sk = ks, hk = kh) => oklch(L, C * sk, h + hk);
    p = {
      main: c(spec.main),
      side: c(spec.side),
      deep: c(spec.deep),
      pale: c(spec.pale),
      base: c(spec.base, 1, kh * 0.5),
      shade: [...spec.shade],
    };
    paletteMemo.set(key, p);
  }
  return p;
}

// ---------- the pose ----------

/** Everything one frame depends on. `ta` is seconds on the orb's own clock; ages are -1 when nothing happened yet. */
export type OrbPose = {
  ta: number;
  /** 0 at rest, 1 listening (can overshoot a little). */
  listen: number;
  think: number;
  /** The landing's glow, 0 to 1. */
  done: number;
  smile: number;
  tilt: number;
  /** Where it looks: right and down, about -1 to 1. */
  ax: number;
  ay: number;
  blink: number;
  nod: number;
  doneAge: number;
  noticeAge: number;
  /** Seconds into a finish (a check and a burst of rays, `finishPhase`), or -1 when none is playing. */
  finishAge: number;
  /** -1 to 1, a slow breath. */
  breath: number;
};

// ---------- the finish ----------

/** How long a finish plays, in seconds, from the eyes giving way to the check until they are back. */
export const FINISH_S = 1.2;
/** A moment in a finish when the check is whole and the rays have gone: the finish as a still. */
export const FINISH_HELD = 0.8;
/** The short strokes that burst out round the orb when it finishes. */
export const RAYS = 10;

/** Where a finish is at one moment. Every part of it is a pure function of its age. */
export type FinishPhase = {
  /** How much of the check is drawn along its stroke, 0 to 1. */
  check: number;
  /** The check's opacity: whole while it holds, gone as the eyes come back. */
  checkAlpha: number;
  /** How far the rays have flown, 0 to 1, or -1 before they leave and once they have faded. */
  rays: number;
  /** The eye-lights' opacity: they give way to the check and come back after it. */
  eyes: number;
  /** The sphere's pop as the check lands, 0 to 1. */
  pop: number;
};

const NO_FINISH: FinishPhase = {
  check: 0,
  checkAlpha: 0,
  rays: -1,
  eyes: 1,
  pop: 0,
};

/**
 * A finish `age` seconds in: the eyes fade as the sphere pops and the check strokes on, the rays
 * burst outward and fade, the check holds, then fades as the eyes come back. -1 is no finish.
 */
export function finishPhase(age: number): FinishPhase {
  if (!(age >= 0 && age < FINISH_S)) return NO_FINISH;
  const back = smooth((age - 0.85) / 0.3);
  return {
    check: eout((age - 0.06) / 0.3),
    checkAlpha: 1 - back,
    rays: age >= 0.1 && age < 0.75 ? (age - 0.1) / 0.65 : -1,
    eyes: age < 0.85 ? 1 - smooth(age / 0.12) : back,
    pop: bump(age / 0.5),
  };
}

// ---------- the orb's pieces ----------

type Ctx = CanvasRenderingContext2D;

/** A colour mass's opacity from its centre out: [distance as a share of its radius, share of its opacity]. */
const FALLOFF = [
  [0, 1],
  [0.42, 0.78],
  [0.76, 0.24],
  [1, 0],
] as const;
/** How opaque a colour mass is at its centre. */
const MASS_ALPHA = 0.94;

function blob(ctx: Ctx, x: number, y: number, r: number, c: Rgb, a: number) {
  if (a <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  for (const [at, share] of FALLOFF) g.addColorStop(at, rgba(c, a * share));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function light(ctx: Ctx, x: number, y: number, r: number, a: number) {
  if (a <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${clamp(a).toFixed(3)})`);
  g.addColorStop(0.45, `rgba(255,255,255,${clamp(a * 0.42).toFixed(3)})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function circle(ctx: Ctx, r: number) {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
}

// angle, orbit, radius of the mesh's four colour masses
const MESH = [
  [3.95, 0.43, 0.88],
  [5.5, 0.45, 0.74],
  [0.78, 0.45, 0.86],
  [2.36, 0.45, 0.88],
] as const;

function meshPos(ta: number, fast: boolean, turn: number) {
  const rot = turn + (fast ? 1.45 * ta + 1.1 : 0.22 * ta);
  return MESH.map((b, i) => {
    const a =
      b[0] +
      rot +
      (fast
        ? 0.5 * Math.sin(1.1 * ta + i * 1.93)
        : 0.42 * Math.sin(0.29 * ta + i * 1.93));
    return [Math.cos(a) * b[1], Math.sin(a) * b[1], b[2]] as const;
  });
}

/**
 * Four soft colour masses drifting round a pale base, starting `turn` radians round; a faster swirl
 * joins them while it works.
 */
function mesh(
  ctx: Ctx,
  R: number,
  S: OrbPose,
  pal: Palette,
  turn: number,
  lx: number,
  ly: number,
) {
  ctx.fillStyle = rgba(pal.base, 1);
  ctx.fillRect(-R * 1.7, -R * 1.7, R * 3.4, R * 3.4);
  const cols = [pal.main, pal.pale, pal.side, pal.deep];
  meshPos(S.ta, false, turn).forEach((p, i) => {
    blob(
      ctx,
      p[0] * R + lx * R,
      p[1] * R + ly * R,
      p[2] * R,
      cols[i],
      MASS_ALPHA,
    );
  });
  const swirl = S.think * 0.55;
  if (swirl > 0.01) {
    meshPos(S.ta, true, turn).forEach((p, i) => {
      blob(
        ctx,
        p[0] * R + lx * R * 0.6,
        p[1] * R + ly * R * 0.6,
        p[2] * R * 0.92,
        cols[i],
        0.9 * swirl,
      );
    });
  }
}

/** A colour mass's share of its opacity at `d`, its distance from the centre as a share of its radius. */
function falloffAt(d: number): number {
  for (let i = 1; i < FALLOFF.length; i++) {
    const [at, share] = FALLOFF[i] as readonly [number, number];
    const [from, start] = FALLOFF[i - 1] as readonly [number, number];
    if (d <= at) return lerp(start, share, (d - from) / (at - from));
  }
  return 0;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number) =>
  Math.round(
    255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * clamp(v) ** (1 / 2.4) - 0.055),
  );

/** An sRGB colour in OKLab, as [L, a, b]. */
export function oklab(c: Rgb): [number, number, number] {
  const [r, g, b] = c.map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const swatchMemo = new Map<OrbPaletteName, Rgb>();

/**
 * The one colour an orb in `name` reads as where it is too small to see its colours drift, as in a
 * list at 28px: its resting colour masses laid over its pale base the way the canvas lays them, then
 * averaged as light over the disc and over every way its masses can be turned. The rim and the
 * eye-lights are the same on every orb, so they are left out.
 */
export function orbSwatch(name: OrbPaletteName): Rgb {
  const known = swatchMemo.get(name);
  if (known) return known;
  // At rest the orb draws its colour at 0.9 of its saturation (`drawBotOrb`).
  const pal = palette(name, 0.9, 0);
  const cols = [pal.main, pal.pale, pal.side, pal.deep];
  const sum = [0, 0, 0];
  let n = 0;
  const grid = 24;
  for (let turn = 0; turn < 8; turn++) {
    const masses = meshPos(1.6, false, (turn / 8) * TAU);
    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        const x = ((i + 0.5) / grid) * 2 - 1;
        const y = ((j + 0.5) / grid) * 2 - 1;
        if (x * x + y * y > 1) continue;
        let c: number[] = [...pal.base];
        masses.forEach((p, k) => {
          const a =
            MASS_ALPHA * falloffAt(Math.hypot(x - p[0], y - p[1]) / p[2]);
          const col = cols[k] as Rgb;
          c = c.map((v, ch) => lerp(v, col[ch] as number, a));
        });
        for (let ch = 0; ch < 3; ch++) sum[ch] += toLinear(c[ch] as number);
        n++;
      }
    }
  }
  const swatch = sum.map((v) => toSrgb(v / n)) as Rgb;
  swatchMemo.set(name, swatch);
  return swatch;
}

/** Lit top edge, shaded bottom: what makes the disc read as a sphere. Call inside the clip. */
function rim(ctx: Ctx, R: number, shade: Rgb, dark: boolean) {
  const g = ctx.createRadialGradient(
    0,
    -R * 0.3,
    R * 0.55,
    0,
    -R * 0.12,
    R * 1.16,
  );
  g.addColorStop(0, rgba(shade, 0));
  g.addColorStop(0.72, rgba(shade, 0));
  g.addColorStop(1, rgba(shade, dark ? 0.3 : 0.24));
  ctx.fillStyle = g;
  ctx.fillRect(-R * 1.3, -R * 1.3, R * 2.6, R * 2.6);
  const lw = Math.max(1, R * 0.05);
  const lg = ctx.createLinearGradient(0, -R, 0, R * 0.25);
  lg.addColorStop(0, "rgba(255,255,255,.7)");
  lg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.strokeStyle = lg;
  ctx.lineWidth = lw;
  circle(ctx, R - lw * 0.5);
  ctx.stroke();
}

function glow(ctx: Ctx, R: number, amt: number, c: Rgb, dark: boolean) {
  if (amt < 0.005) return;
  const r = R * 1.85;
  const g = ctx.createRadialGradient(0, 0, R * 0.55, 0, 0, r);
  g.addColorStop(0, rgba(c, amt * (dark ? 0.8 : 0.5)));
  g.addColorStop(0.38, rgba(c, amt * (dark ? 0.34 : 0.18)));
  g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g;
  ctx.fillRect(-r, -r, 2 * r, 2 * r);
}

/** How long the landing's ping rings, in seconds. */
const PING_S = 1;

/** One ring that leaves the orb and fades: the landing's ping. */
function ping(ctx: Ctx, r0: number, age: number, pal: Palette, dark: boolean) {
  if (!(age >= 0 && age < PING_S)) return;
  const u = age / PING_S;
  const r = r0 * (1.02 + (1.5 - 1.02) * eout(u));
  const a = (1 - u) ** 1.5;
  ctx.strokeStyle = rgba(
    dark ? mix(pal.main, WHITE, 0.2) : pal.deep,
    a * (dark ? 0.75 : 0.62),
  );
  ctx.lineWidth = Math.max(1, r0 * 0.07 * (1 - u * 0.6));
  circle(ctx, r);
  ctx.stroke();
}

/**
 * The finish's burst: a ring of short strokes, one straight up, that fly out round the sphere,
 * shortening and fading as they go. Every other one is longer, so the ring sparkles rather than ticks.
 */
function rays(ctx: Ctx, r0: number, u: number, pal: Palette, dark: boolean) {
  if (!(u >= 0 && u < 1)) return;
  const travel = eout(u);
  const a = (1 - u) ** 1.4;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = rgba(
    dark ? mix(pal.main, WHITE, 0.25) : pal.deep,
    a * (dark ? 0.9 : 0.8),
  );
  ctx.lineWidth = Math.max(1, r0 * 0.09 * (1 - 0.5 * u));
  for (let i = 0; i < RAYS; i++) {
    const angle = -PI / 2 + (TAU * i) / RAYS;
    const length = r0 * (i % 2 === 0 ? 0.3 : 0.2) * (1 - 0.55 * u);
    const inner = r0 * (1.3 + 0.32 * travel);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(dx * inner, dy * inner);
    ctx.lineTo(dx * (inner + length), dy * (inner + length));
    ctx.stroke();
  }
  ctx.restore();
}

// The check's three points, as shares of the sphere's radius: in at the left, down to the elbow, up
// to the right. Its two legs are about 0.37 and 0.75 of the radius long.
const CHECK = [
  [-0.38, 0.02],
  [-0.12, 0.28],
  [0.42, -0.26],
] as const;

/** The check, stroked on along its length to `drawn` (0 to 1), in the eye-lights' white. */
function check(
  ctx: Ctx,
  R: number,
  drawn: number,
  alpha: number,
  dark: boolean,
) {
  if (drawn <= 0 || alpha <= 0.003) return;
  const [a, b, c] = CHECK.map(([x, y]) => [x * R, y * R] as const);
  const first = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const second = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const along = drawn * (first + second);
  ctx.save();
  ctx.globalAlpha = clamp(alpha);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1.6, R * 0.17);
  ctx.strokeStyle = "rgba(255,255,255,.97)";
  ctx.shadowColor = dark ? "rgba(8,6,20,.4)" : "rgba(20,16,33,.28)";
  ctx.shadowBlur = Math.max(1, R * 0.07);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  if (along <= first) {
    const u = along / first;
    ctx.lineTo(lerp(a[0], b[0], u), lerp(a[1], b[1], u));
  } else {
    const u = (along - first) / second;
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(lerp(b[0], c[0], u), lerp(b[1], c[1], u));
  }
  ctx.stroke();
  ctx.restore();
}

/** The sphere's scale: it breathes, swells a little to listen and to land, and pops as a check lands. */
function scaleOf(S: OrbPose, finish: FinishPhase) {
  const L = clamp(S.listen, 0, 1.25);
  return (
    1 +
    0.015 * S.breath * (1 - S.think) +
    0.025 * L +
    0.04 * S.done +
    0.06 * finish.pop
  );
}

function eyePath(ctx: Ctx, w: number, h: number, smile: number) {
  const rx = (w / 2) * (1 + 0.12 * smile);
  const ry = h / 2;
  const e = 0.32 * ry * smile;
  const top = -ry;
  const bot = lerp(ry, -0.36 * ry, smile);
  const ct = (top - 0.25 * e) / 0.75;
  const cb = (bot - 0.25 * e) / 0.75;
  ctx.beginPath();
  ctx.moveTo(-rx, e);
  ctx.bezierCurveTo(-rx, ct, rx, ct, rx, e);
  ctx.bezierCurveTo(rx, cb, -rx, cb, -rx, e);
  ctx.closePath();
}

/** How long an orb stays perked up after the pointer comes close, in seconds. */
const PERK_S = 1.6;

/** The sphere: the mesh turned toward where it looks, its rim, and two eye-lights that blink and smile. */
function sphere(
  ctx: Ctx,
  R: number,
  S: OrbPose,
  pal: Palette,
  look: OrbLook,
  dark: boolean,
  size: number,
) {
  const na = S.noticeAge;
  const perk =
    na >= 0 && na < PERK_S ? Math.exp(-2.6 * na) * smooth(na / 0.1) : 0;
  const finish = finishPhase(S.finishAge);
  const sc = scaleOf(S, finish);
  ctx.save();
  ctx.translate(0, S.nod * R * 0.11);
  ctx.scale(sc, sc);
  circle(ctx, R);
  ctx.clip();
  const yaw = clamp(S.ax, -1.1, 1.1) * 0.62;
  const pitch = -clamp(S.ay, -1.1, 1.1) * 0.5;
  const roll = S.tilt;
  mesh(ctx, R, S, pal, look.turn, Math.sin(yaw) * 0.2, -Math.sin(pitch) * 0.16);
  light(ctx, -0.42 * R, -0.5 * R, 0.5 * R, 0.26);
  light(ctx, 0, R * 0.05, R * 0.9, 0.28 * S.done);
  rim(ctx, R, pal.shade, dark);
  const small = size < 40;
  const widen = 1 + 0.16 * perk;
  const open = clamp(1 - 0.94 * S.blink) * (1 - 0.3 * S.think) * widen;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const ew = Math.max(small ? 2.4 : 1.8, R * 0.16 * widen);
  const eh = Math.max(small ? 3.4 : 2.4, R * 0.3);
  for (const side of [-1, 1]) {
    if (finish.eyes <= 0.003) break;
    const lon = side * 0.35 * look.eyes;
    const lat = 0.05 + 0.04 * S.smile;
    const x = Math.sin(lon) * Math.cos(lat);
    const y = Math.sin(lat);
    const z = Math.cos(lon) * Math.cos(lat);
    const y1 = y * Math.cos(pitch) + z * Math.sin(pitch);
    const z1 = -y * Math.sin(pitch) + z * Math.cos(pitch);
    const x2 = x * Math.cos(yaw) + z1 * Math.sin(yaw);
    const sx = x2 * cr - y1 * sr;
    const sy = x2 * sr + y1 * cr;
    const fx = Math.sqrt(clamp(1 - sx * sx, 0.12, 1));
    const fy = Math.sqrt(clamp(1 - sy * sy, 0.2, 1));
    const h = Math.max(small ? 1.1 : 0.9, eh * open * fy);
    ctx.save();
    ctx.globalAlpha = finish.eyes;
    ctx.translate(sx * R * 0.84, -sy * R * 0.84 + (eh - h) * 0.28);
    ctx.rotate(-roll);
    ctx.shadowColor = dark ? "rgba(8,6,20,.4)" : "rgba(20,16,33,.28)";
    ctx.shadowBlur = Math.max(1, R * 0.07);
    ctx.fillStyle = "rgba(255,255,255,.97)";
    eyePath(ctx, ew * fx, h, clamp(S.smile) * (1 - S.blink));
    ctx.fill();
    ctx.restore();
  }
  check(ctx, R, finish.check, finish.checkAlpha, dark);
  ctx.restore();
}

/**
 * The whole orb with `look`, centred on the context's origin, for a footprint of `size` CSS px.
 * Its glow, the landing's ping and a finish's rays spill past the footprint, so draw it on a canvas
 * twice its size.
 */
export function drawBotOrb(
  ctx: Ctx,
  size: number,
  S: OrbPose,
  { dark, look }: { dark: boolean; look: OrbLook },
) {
  const finish = finishPhase(S.finishAge);
  const pal = palette(
    look.palette,
    0.9 + 0.14 * clamp(S.listen) + 0.08 * S.think + 0.12 * clamp(S.done),
    look.hue - 6 * S.think,
  );
  const r = (size / 2) * 0.72;
  const sc = scaleOf(S, finish);
  const glowAmt = clamp(
    0.18 +
      0.42 * clamp(S.listen) +
      0.22 * S.think +
      0.55 * S.done +
      0.45 * finish.pop,
  );
  glow(ctx, r * sc, glowAmt * 0.85, mix(pal.main, pal.deep, 0.4), dark);
  ping(ctx, r, S.doneAge, pal, dark);
  rays(ctx, r, finish.rays, pal, dark);
  sphere(ctx, r, S, pal, look, dark, size * 0.72);
}

/** How long each age in a pose shows, in seconds: after that the orb draws as if it never happened. */
const SHOWS_FOR: Partial<Record<keyof OrbPose, number>> = {
  doneAge: PING_S,
  noticeAge: PERK_S,
  finishAge: FINISH_S,
};

/**
 * Whether two poses draw the same picture, every value within a thousandth of the other's. An age
 * counts only while what it times still shows, so an orb that has settled poses the same picture
 * frame after frame and need not draw it again.
 */
export function samePicture(a: OrbPose, b: OrbPose): boolean {
  for (const key of Object.keys(a) as (keyof OrbPose)[]) {
    const shows = SHOWS_FOR[key];
    const seen = (v: number) =>
      shows === undefined || (v >= 0 && v < shows) ? v : -1;
    if (Math.abs(seen(a[key]) - seen(b[key])) >= 1e-3) return false;
  }
  return true;
}
