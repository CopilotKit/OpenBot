import { describe, expect, test } from "bun:test";
import { mendHoles, type Size, stillFit, stillMask } from "./buddy-matte";

const clip: Size = { width: 20, height: 20 };
const area = clip.width * clip.height;

/** A frame: a solid square from 3 to 16, clear around it, with the given boxes cut clear inside. */
function frame(holes: Array<[number, number, number, number]>): Uint8Array {
  const rgba = new Uint8Array(area * 4).fill(250);
  for (let y = 0; y < clip.height; y++)
    for (let x = 0; x < clip.width; x++) {
      const inside = x >= 3 && x <= 16 && y >= 3 && y <= 16;
      const cut = holes.some(
        ([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1,
      );
      rgba[(y * clip.width + x) * 4 + 3] = inside && !cut ? 255 : 0;
    }
  return rgba;
}

function frames(...list: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(list.length * area * 4);
  for (const [i, one] of list.entries()) all.set(one, i * area * 4);
  return all;
}

const alpha = (all: Uint8Array, t: number, x: number, y: number) =>
  all[t * area * 4 + (y * clip.width + x) * 4 + 3];

/** The still: the square, solid, with a real gap at 11..14 × 11..14. */
const still = (() => {
  const mask = new Uint8Array(area);
  for (let y = 3; y <= 16; y++)
    for (let x = 3; x <= 16; x++)
      if (!(x >= 11 && x <= 14 && y >= 11 && y <= 14))
        mask[y * clip.width + x] = 1;
  return mask;
})();

describe("mendHoles", () => {
  test("fills a hole where the still is solid, and keeps a gap where it is clear", () => {
    const all = frames(
      frame([
        [6, 6, 8, 8],
        [11, 11, 14, 14],
      ]),
    );
    mendHoles(all, clip, still);
    expect(alpha(all, 0, 7, 7)).toBe(255);
    expect(alpha(all, 0, 12, 12)).toBe(0);
    expect(alpha(all, 0, 0, 0)).toBe(0);
  });

  test("fills a hole that opens later where the character was solid, as an eye after a blink", () => {
    const all = frames(frame([]), frame([[6, 6, 8, 8]]));
    mendHoles(all, clip, still);
    expect(alpha(all, 1, 7, 7)).toBe(255);
  });

  test("keeps a gap that the character moved over a little", () => {
    const all = frames(frame([[11, 11, 14, 14]]), frame([[10, 11, 13, 14]]));
    mendHoles(all, clip, still);
    expect(alpha(all, 1, 10, 12)).toBe(0);
    expect(alpha(all, 1, 12, 12)).toBe(0);
  });

  test("keeps a gap formed when the character closes around the background", () => {
    // A notch open to the edge in the first frame, closed in the second.
    const open = frame([[8, 0, 10, 8]]);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < clip.width; x++)
        open[(y * clip.width + x) * 4 + 3] = 0;
    const closed = frame([[8, 5, 10, 8]]);
    const all = frames(open, closed);
    mendHoles(all, clip, still);
    expect(alpha(all, 1, 9, 6)).toBe(0);
  });
});

describe("stillMask", () => {
  test("lays the still over the clip centred, at the fitted size", () => {
    const fit = stillFit(
      { width: 384, height: 688 },
      { width: 360, height: 640 },
    );
    expect(fit).toEqual({ width: 368, height: 659 });
    const rgba = new Uint8Array(fit.width * fit.height * 4);
    // One solid pixel at the still's centre.
    const cx = Math.floor(fit.width / 2);
    const cy = Math.floor(fit.height / 2);
    rgba[(cy * fit.width + cx) * 4 + 3] = 255;
    const mask = stillMask(rgba, fit, { width: 360, height: 640 });
    const left = Math.round((360 - fit.width) / 2);
    const top = Math.round((640 - fit.height) / 2);
    expect(mask[(cy + top) * 360 + (cx + left)]).toBe(1);
    expect(mask.reduce((sum, v) => sum + v, 0)).toBe(1);
  });
});
