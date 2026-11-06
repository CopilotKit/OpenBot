import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  blinkAt,
  drawKite,
  eyeCells,
  eyeColor,
  FACE_MIN,
  faceOn,
  KITE_COLORS,
  KITE_STATES,
  KITE_STATUS,
  type KiteState,
  kiteBleed,
  needsFrames,
  OPENBOT_SLOT,
  pixelFace,
  pixelPx,
  pose,
  poseAt,
  STILL_MAX,
  stillPose,
  tones,
} from "@/components/agents/kite/kite-draw";

/*
 * OpenBot's mascot, the Pro pixel kite, held to the spec it was picked from
 * (F-pixel-kite-mascot.md): the palette, the states, when a face shows, how it moves, and what it
 * gives up as it gets smaller.
 */

describe("the palette", () => {
  test("is the eight brand colours, each with its dark twin, in the orb's slot order", () => {
    expect(KITE_COLORS.map((c) => [c.name, c.hex, c.darkHex])).toEqual([
      ["mint", "#189370", "#2fb38b"],
      ["violet", "#6430ab", "#9265dd"],
      ["blue", "#005dbb", "#3d8ae6"],
      ["teal", "#0e7c86", "#22a6b0"],
      ["copper", "#b4561a", "#e07b3a"],
      ["raspberry", "#a8325e", "#d75c86"],
      ["plum", "#7b2f7a", "#b061ae"],
      ["graphite", "#2b2b2b", "#e9e9ef"],
    ]);
  });

  test("violet is OpenBot's own", () => {
    expect(KITE_COLORS[OPENBOT_SLOT].name).toBe("violet");
  });

  test("dark mode draws each colour's lifted twin", () => {
    expect(tones(OPENBOT_SLOT, false).base).toBe("#6430ab");
    expect(tones(OPENBOT_SLOT, true).base).toBe("#9265dd");
  });

  test("eyes are white on a dark body and near-black on a light one", () => {
    expect(eyeColor("#6430ab")).toBe("#ffffff");
    expect(eyeColor("#9265dd")).toBe("#ffffff");
    expect(eyeColor("#e9e9ef")).toBe("#121216");
  });

  test("the status dot is in the reserved system colours, and idle and sleeping have none", () => {
    expect(KITE_STATUS).toEqual({
      listening: "#2f6fed",
      thinking: "#2f6fed",
      streaming: "#2f6fed",
      waiting: "#d99a06",
      done: "#1f9d55",
      error: "#dc3d3d",
    });
  });
});

describe("the face", () => {
  test("shows only at contact: listening, answering, waiting and done", () => {
    expect(KITE_STATES.filter(faceOn)).toEqual([
      "listening",
      "streaming",
      "waiting",
      "done",
    ]);
  });

  test("a mascot pixel is 5.5% of the Bot, never under one screen pixel", () => {
    expect(pixelPx(16)).toBe(1);
    expect(pixelPx(24)).toBe(1);
    expect(pixelPx(32)).toBe(2);
    expect(pixelPx(96)).toBe(5);
  });

  test("there is no face under 22 px", () => {
    expect(FACE_MIN).toBe(22);
    expect(pixelFace(stillPose("listening"), 21).w).toBe(0);
    expect(pixelFace(stillPose("listening"), 22).w).toBe(1);
  });

  test("open eyes are 2×3 each, waiting's are 2×4, a blink is one row, done is ^ ^", () => {
    expect(eyeCells("open", 0, 0)).toHaveLength(12);
    expect(eyeCells("tall", 0, 0)).toHaveLength(16);
    expect(new Set(eyeCells("blink", 0, 0).map(([, r]) => r)).size).toBe(1);
    expect(eyeCells("happy", 0, 0)).toEqual([
      [-3, 0],
      [-2, -1],
      [-1, 0],
      [1, 0],
      [2, -1],
      [3, 0],
    ]);
  });

  test("gaze moves the eyes a whole pixel, and only from 48 px", () => {
    const listening = stillPose("listening");
    expect(pixelFace(listening, 40).cells).toEqual(eyeCells("open", 0, 0));
    // Listening looks down toward what is being typed.
    expect(pixelFace(listening, 96).cells).toEqual(eyeCells("open", -1, 1));
  });

  test("never glances up and to the right, a look that belongs to another mascot", () => {
    const timeline = (s: KiteState) => [
      { s: "idle" as const, t: -9 },
      { s, t: 0 },
    ];
    // The whole pixels the gaze moves the eyes by, as `pixelFace` rounds it.
    const step = (v: number) => Math.max(-1, Math.min(1, Math.round(v * 1.3)));
    for (const s of KITE_STATES) {
      for (let t = 0; t < 12; t += 0.05) {
        const P = pose(timeline(s), t, 7);
        expect(step(P.gx) > 0 && step(P.gy) < 0).toBe(false);
      }
    }
  });
});

describe("motion", () => {
  const change = (from: KiteState, to: KiteState) => [
    { s: from, t: -9 },
    { s: to, t: 10 },
  ];

  test("a change of state blends over 0.26 s, then holds", () => {
    const tl = change("idle", "listening");
    expect(pose(tl, 10, 1).gy).toBe(0);
    const mid = pose(tl, 10.13, 1).gy;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.45);
    expect(pose(tl, 10.26, 1).gy).toBeCloseTo(0.45, 6);
  });

  test("the eyes take 0.7 s to form, and 0.5 s to scatter", () => {
    const wake = change("idle", "listening");
    expect(pose(wake, 10.35, 1).wake).toBeCloseTo(0.5, 6);
    expect(pose(wake, 10.71, 1).wake).toBe(1);
    const sleep = change("listening", "sleeping");
    expect(pose(sleep, 10.25, 1).wake).toBeCloseTo(0.5, 6);
    expect(pose(sleep, 10.51, 1).wake).toBe(0);
  });

  test("each Bot blinks on its own schedule, every 3 to 7 s", () => {
    const closes = (seed: number) => {
      const at: number[] = [];
      for (let t = 0; t < 60; t += 0.01) {
        if (blinkAt(seed, t) === 0 && (at.length === 0 || t - at.at(-1)! > 0.2))
          at.push(t);
      }
      return at;
    };
    const a = closes(11);
    const b = closes(12);
    expect(a.length).toBeGreaterThan(7);
    expect(a).not.toEqual(b);
    // A double blink is 0.3 s apart; otherwise blinks are 3–7 s apart.
    for (let i = 1; i < a.length; i++) {
      const gap = a[i] - a[i - 1];
      expect(gap < 0.4 || (gap > 2.9 && gap < 7.1)).toBe(true);
    }
  });

  test("a page left open keeps blinking", () => {
    let blinked = false;
    for (let t = 5000; t < 5010; t += 0.01)
      if (blinkAt(3, t) < 0.5) blinked = true;
    expect(blinked).toBe(true);
  });

  test("at 32 px and under the body and face hold still, and only the dot moves", () => {
    expect(STILL_MAX).toBe(32);
    const tl = change("idle", "waiting");
    for (const t of [10.05, 10.3, 11, 14.85]) {
      const P = poseAt(tl, t, 1, 32, false);
      expect(P.dy).toBe(0);
      expect(P.wake).toBe(1);
      expect(P.blink).toBe(1);
      expect(P.since).toBeCloseTo(t - 10, 6);
    }
    // Above it, waiting nudges the body.
    expect(poseAt(tl, 14.86, 1, 48, false).dy).toBeGreaterThan(0);
  });

  test("reduced motion draws each state's still", () => {
    const P = poseAt(change("idle", "done"), 10.1, 1, 96, true);
    expect(P).toEqual(stillPose("done"));
  });

  test("a Bot asks for frames only while something moves", () => {
    // Every change of state plays out first.
    expect(needsFrames("idle", 24, 0.5)).toBe(true);
    // Then a resting, sleeping or failed Bot is a still picture at any size.
    for (const s of ["idle", "sleeping", "error"] as const) {
      expect(needsFrames(s, 24, 5)).toBe(false);
      expect(needsFrames(s, 96, 5)).toBe(false);
    }
    // Working's pulse and waiting's nudge run at every size.
    for (const s of ["thinking", "waiting"] as const) {
      expect(needsFrames(s, 16, 5)).toBe(true);
    }
    // A face blinks only above 32 px.
    expect(needsFrames("listening", 32, 5)).toBe(false);
    expect(needsFrames("listening", 40, 5)).toBe(true);
  });

  test("the drawing reaches past the slot far enough for working's widest pulse", () => {
    for (const S of [16, 20, 22, 24, 28, 32, 40, 48, 64, 96, 128, 176]) {
      const h = Math.min(12, Math.max(2.5, S * 0.075));
      expect(0.36 * S + 2.2 * h + Math.max(1, S * 0.012)).toBeLessThanOrEqual(
        S / 2 + kiteBleed(S),
      );
    }
  });
});

/** A 2D context that records what is filled, in which colour, and how. */
class Recorder {
  fills: { style: string; op: string; rect: number[]; alpha: number }[] = [];
  bodies: { style: string; alpha: number }[] = [];
  fillStyle = "";
  strokeStyle = "";
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  private stack: { alpha: number; op: string }[] = [];
  save() {
    this.stack.push({
      alpha: this.globalAlpha,
      op: this.globalCompositeOperation,
    });
  }
  restore() {
    const top = this.stack.pop();
    if (top) {
      this.globalAlpha = top.alpha;
      this.globalCompositeOperation = top.op;
    }
  }
  fillRect(...rect: number[]) {
    this.fills.push({
      style: this.fillStyle,
      op: this.globalCompositeOperation,
      rect,
      alpha: this.globalAlpha,
    });
  }
  fill(path?: unknown) {
    if (path)
      this.bodies.push({ style: this.fillStyle, alpha: this.globalAlpha });
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
  translate() {}
  scale() {}
  clip() {}
  stroke() {}
  strokeRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  quadraticCurveTo() {}
}

describe("the drawing", () => {
  const original = globalThis.Path2D;
  beforeAll(() => {
    globalThis.Path2D = class {
      moveTo() {}
      lineTo() {}
      closePath() {}
    } as unknown as typeof Path2D;
  });
  afterAll(() => {
    globalThis.Path2D = original;
  });

  const draw = (state: KiteState, S: number, dark = false) => {
    const ctx = new Recorder();
    drawKite(ctx as unknown as CanvasRenderingContext2D, {
      S,
      x: 50,
      y: 50,
      slot: OPENBOT_SLOT,
      pattern: "solid",
      dark,
      pose: stillPose(state),
      seed: 1,
    });
    return ctx;
  };
  const eyes = (ctx: Recorder) =>
    ctx.fills.filter((f) => f.style === "#ffffff" && f.op === "source-over");

  test("a listening Bot at 24 px has its twelve eye pixels; at 21 px none", () => {
    expect(eyes(draw("listening", 24))).toHaveLength(12);
    expect(eyes(draw("listening", 21))).toHaveLength(0);
  });

  test("idle has no face and no dot", () => {
    const ctx = draw("idle", 96);
    expect(eyes(ctx)).toHaveLength(0);
    expect(ctx.fills.some((f) => f.op === "destination-out")).toBe(false);
  });

  test("sleeping is dimmed, with no face and no dot", () => {
    const ctx = draw("sleeping", 96);
    expect(ctx.bodies[0]).toEqual({ style: "#6430ab", alpha: 0.5 });
    expect(eyes(ctx)).toHaveLength(0);
    expect(ctx.fills.some((f) => f.op === "destination-out")).toBe(false);
  });

  test("the dot is cut out of the kite, so any background shows round it", () => {
    const ctx = draw("waiting", 24);
    const cut = ctx.fills.findIndex((f) => f.op === "destination-out");
    const dot = ctx.fills.findIndex((f) => f.style === "#d99a06");
    expect(cut).toBeGreaterThan(-1);
    expect(dot).toBeGreaterThan(cut);
  });

  test("each state's dot is its own colour", () => {
    for (const s of [
      "thinking",
      "streaming",
      "waiting",
      "done",
      "error",
    ] as const)
      expect(draw(s, 32).fills.some((f) => f.style === KITE_STATUS[s])).toBe(
        true,
      );
  });

  test("in dark mode the body is the dark twin", () => {
    expect(draw("idle", 48, true).bodies[0].style).toBe("#9265dd");
  });
});
