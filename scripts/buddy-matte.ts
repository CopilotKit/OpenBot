/**
 * Mends the holes a stock buddy's clips were cut with.
 *
 * Each clip was cut out of a light grey-white background, and the cutout took the character's own
 * whites with it: the whites of its eyes, a white sneaker, a highlight. They are clear in the clip,
 * so on OpenBot's dark page they show as black. A hole like that is enclosed by the character, but
 * so is a real gap (between an arm and the body, under a headphone band), and its colour can't tell
 * them apart: an eye white is as grey-white as the background.
 *
 * Where a hole was before can. Each pixel remembers what it was the last time it was clear: the
 * background (or a gap), or a hole that was filled. A hole goes the way most of its pixels went: a gap
 * an arm closes around was background, an eye white was filled. Where too little of a hole has been
 * clear lately (the first frame, an eye that opens after a blink), the still picture decides. It is
 * cut out well, and each clip starts on it: a hole where the still is solid is the character's.
 */

/** How far back, in frames, what a pixel was when last clear still counts. */
const MEMORY = 48;
/** How much of a hole must have been clear lately for that to decide it, not the still. */
const KNOWN = 0.3;
/** Below this alpha a pixel is clear. */
const CLEAR = 128;
/** How far around a filled hole its soft edge is filled too, in pixels. */
const EDGE = 2;

/**
 * Where the still sits on a clip's first frame: centred, and this much wider than the clip. Found by
 * fitting every stock buddy's still to its clips' first frames.
 */
export const STILL_ZOOM = 368 / 360;

export type Size = { width: number; height: number };

/**
 * The still's cutout laid over a clip's frame: 1 where the still is solid. `still` is the still's
 * RGBA, already scaled to `fit`, the size `stillFit` gives.
 */
export function stillMask(
  still: Uint8Array,
  fit: Size,
  clip: Size,
): Uint8Array {
  const left = Math.round((clip.width - fit.width) / 2);
  const top = Math.round((clip.height - fit.height) / 2);
  const mask = new Uint8Array(clip.width * clip.height);
  for (let y = 0; y < clip.height; y++)
    for (let x = 0; x < clip.width; x++) {
      const sx = x - left;
      const sy = y - top;
      if (sx < 0 || sy < 0 || sx >= fit.width || sy >= fit.height) continue;
      if ((still[(sy * fit.width + sx) * 4 + 3] ?? 0) >= CLEAR)
        mask[y * clip.width + x] = 1;
    }
  return mask;
}

/** The size the still is scaled to before `stillMask` lays it over a clip. */
export function stillFit(still: Size, clip: Size): Size {
  const width = Math.round(clip.width * STILL_ZOOM);
  return { width, height: Math.round((width * still.height) / still.width) };
}

/**
 * Fills, in place, the holes in a clip's frames (RGBA, one after another) that are the character's.
 * Returns how many pixels it made solid.
 */
export function mendHoles(
  frames: Uint8Array,
  clip: Size,
  still: Uint8Array,
): number {
  const { width: W, height: H } = clip;
  const area = W * H;
  const count = frames.length / (area * 4);
  // What each pixel was the last time it was clear: 1 a filled hole, 2 background. 0: never.
  const seen = new Uint8Array(area);
  const when = new Int32Array(area);

  const clear = new Uint8Array(area);
  const region = new Int8Array(area); // 0 unvisited, -1 background, 1 a hole, 2 a kept gap
  const fill = new Uint8Array(area);
  const stack: number[] = [];
  let mended = 0;

  const visit = (i: number, mark: number) => {
    if (clear[i] && !region[i]) {
      region[i] = mark;
      stack.push(i);
    }
  };
  const flood = (mark: number): number[] => {
    const pixels: number[] = [];
    while (stack.length) {
      const i = stack.pop() as number;
      pixels.push(i);
      const x = i % W;
      if (x > 0) visit(i - 1, mark);
      if (x < W - 1) visit(i + 1, mark);
      if (i >= W) visit(i - W, mark);
      if (i < area - W) visit(i + W, mark);
    }
    return pixels;
  };

  for (let t = 0; t < count; t++) {
    const base = t * area * 4;
    for (let i = 0; i < area; i++) {
      clear[i] = (frames[base + i * 4 + 3] ?? 0) < CLEAR ? 1 : 0;
      region[i] = 0;
      fill[i] = 0;
    }
    // The background: everything clear that reaches the frame's edge.
    for (let x = 0; x < W; x++) {
      visit(x, -1);
      visit(area - W + x, -1);
    }
    for (let y = 0; y < H; y++) {
      visit(y * W, -1);
      visit(y * W + W - 1, -1);
    }
    flood(-1);

    for (let i = 0; i < area; i++) {
      if (!clear[i] || region[i]) continue;
      visit(i, 1);
      const hole = flood(1);
      let character = 0;
      let background = 0;
      let solid = 0;
      for (const p of hole) {
        if (still[p]) solid++;
        if (!seen[p] || t - (when[p] ?? 0) > MEMORY) continue;
        if (seen[p] === 1) character++;
        else background++;
      }
      const known = character + background >= hole.length * KNOWN;
      const keep = known ? background > character : solid * 2 < hole.length;
      for (const p of hole) {
        if (keep) region[p] = 2;
        else fill[p] = 1;
      }
    }

    for (let i = 0; i < area; i++) {
      if (!clear[i]) continue;
      seen[i] = fill[i] ? 1 : 2;
      when[i] = t;
    }

    // Fill each hole and its soft edge, never reaching the background or a kept gap.
    for (let i = 0; i < area; i++) {
      if (!fill[i]) continue;
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -EDGE; dy <= EDGE; dy++)
        for (let dx = -EDGE; dx <= EDGE; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx;
          if (region[j] === -1 || region[j] === 2) continue;
          const a = base + j * 4 + 3;
          if ((frames[a] ?? 255) < 255) {
            frames[a] = 255;
            mended++;
          }
        }
    }
  }
  return mended;
}
