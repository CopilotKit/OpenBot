import { describe, expect, test } from "bun:test";
import {
  drawBotOrb,
  FINISH_HELD,
  FINISH_S,
  finishPhase,
  ORB_PALETTES,
  type OrbPose,
  oklch,
  orbPaletteFor,
  palette,
  RAYS,
  track,
} from "@/components/agents/orb/bot-orb-draw";

const REST: OrbPose = {
  ta: 1.6,
  listen: 0,
  think: 0,
  done: 0,
  smile: 0,
  tilt: 0,
  ax: 0,
  ay: 0.04,
  blink: 0,
  nod: 0,
  doneAge: -1,
  noticeAge: -1,
  finishAge: -1,
  breath: 0,
};

/**
 * Just enough of a 2D context to run the drawing: it counts every stroke, and counts the frames
 * drawn, each of which starts by clearing the canvas.
 */
function fakeContext() {
  const gradient = { addColorStop: () => {} };
  const ctx = {
    strokes: 0,
    draws: 0,
    stroke() {
      this.strokes++;
    },
    clearRect() {
      this.draws++;
    },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  return new Proxy(ctx, {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : () => {},
    set: (target, key, value) => {
      (target as Record<string | symbol, unknown>)[key] = value;
      return true;
    },
  });
}

/** Every stroke one frame draws: the rim, the landing's ping, and a finish's rays and check. */
const strokesOf = (pose: OrbPose) => {
  const ctx = fakeContext();
  drawBotOrb(ctx as unknown as CanvasRenderingContext2D, 60, pose, {
    dark: false,
    palette: "violet",
  });
  return ctx.strokes;
};

/** The Bots a fresh OpenBot ships with, whose ids are their seeds. */
const TEAM = [
  "expense-review",
  "feedback-digest",
  "interview-notes",
  "meeting-follow-ups",
  "onboarding-buddy",
  "oncall-handover",
  "release-notes",
  "research-desk",
  "ticket-triage",
];

describe("the orb's motion", () => {
  test("an eased key arrives and a spring overshoots, then both settle on the target", () => {
    const eased = { from: 0, keys: [{ at: 1, to: 1, ease: 0.4 }] };
    expect(track(eased, 0.5)).toBe(0);
    expect(track(eased, 1.2)).toBeGreaterThan(0);
    expect(track(eased, 2)).toBe(1);

    const sprung = {
      from: 0,
      keys: [{ at: 0, to: 1, spring: [14, 0.5] as const }],
    };
    const peak = Math.max(
      ...Array.from({ length: 60 }, (_, i) => track(sprung, i / 60)),
    );
    expect(peak).toBeGreaterThan(1);
    expect(track(sprung, 5)).toBeCloseTo(1, 4);
  });

  test("a later key moves on from where the earlier one left it", () => {
    const tr = {
      from: 0,
      keys: [
        { at: 0, to: 1, ease: 0.4 },
        { at: 1, to: 0.25, ease: 0.4 },
      ],
    };
    expect(track(tr, 0.9)).toBe(1);
    expect(track(tr, 3)).toBe(0.25);
  });
});

describe("the colours", () => {
  test("every palette's base is pale and its shade deep", () => {
    for (const name of ORB_PALETTES) {
      const pal = palette(name, 1, 0);
      expect(Math.min(...pal.base)).toBeGreaterThan(200);
      expect(Math.max(...pal.deep)).toBeLessThan(230);
      expect(Math.max(...pal.shade)).toBeLessThan(100);
    }
  });

  test("a colour outside sRGB loses chroma rather than turning into another hue", () => {
    const [r, g, b] = oklch(0.6, 0.5, 262);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  test("a seed always gets the same palette", () => {
    for (const seed of TEAM) {
      expect(orbPaletteFor(seed)).toBe(orbPaletteFor(seed));
      expect(ORB_PALETTES).toContain(orbPaletteFor(seed));
    }
    // Pinned, so a change to the hash, which would recolour every Bot, can't land unnoticed.
    expect(orbPaletteFor("research-desk")).toBe("sky");
    expect(orbPaletteFor("release-notes")).toBe("violet");
    expect(ORB_PALETTES).toContain(orbPaletteFor(""));
  });

  test("nine palettes, and a team of nine seeds uses more than four of them", () => {
    expect(ORB_PALETTES).toHaveLength(9);
    expect(new Set(ORB_PALETTES).size).toBe(9);
    expect(new Set(TEAM.map(orbPaletteFor)).size).toBeGreaterThan(4);
  });

  test("each palette is a colour of its own", () => {
    const bases = ORB_PALETTES.map((name) => palette(name, 1, 0).main.join());
    expect(new Set(bases).size).toBe(ORB_PALETTES.length);
  });
});

describe("the drawing", () => {
  test("has no grilles: at rest its only stroke is the sphere's rim", () => {
    expect(strokesOf(REST)).toBe(1);
  });
});

describe("a finish", () => {
  test("the eyes give way to a check while the rays fly, then the eyes come back", () => {
    expect(finishPhase(-1)).toMatchObject({ check: 0, rays: -1, eyes: 1 });

    const burst = finishPhase(0.4);
    expect(burst.eyes).toBe(0);
    expect(burst.check).toBe(1);
    expect(burst.rays).toBeGreaterThan(0);
    expect(burst.rays).toBeLessThan(1);

    // Held: the check whole, the burst over.
    expect(finishPhase(FINISH_HELD)).toMatchObject({
      check: 1,
      checkAlpha: 1,
      rays: -1,
      eyes: 0,
    });

    expect(finishPhase(FINISH_S)).toEqual(finishPhase(-1));
  });

  test("the check strokes on along its length", () => {
    const early = finishPhase(0.12).check;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(finishPhase(0.24).check);
  });

  test("draws its rays and its check over the orb, and nothing once it is over", () => {
    const rest = strokesOf(REST);
    expect(strokesOf({ ...REST, finishAge: 0.4 })).toBe(rest + RAYS + 1);
    expect(strokesOf({ ...REST, finishAge: FINISH_HELD })).toBe(rest + 1);
    expect(strokesOf({ ...REST, finishAge: FINISH_S })).toBe(rest);
  });
});
