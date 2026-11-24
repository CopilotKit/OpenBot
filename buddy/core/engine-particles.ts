// One config-driven particle emitter on a <canvas>, shared by every particle
// preset (starfield, bokeh, sparkles, flames, confetti, snow, rain, fireflies,
// hearts, bubbles, and the macro sub-layers). Config is read from the preset and
// tuned by the layer's density/speed/tint. Particles are pre-allocated and
// reused — nothing is allocated in the draw loop.
import { type CanvasStep, mountCanvas } from "./engine-canvas";
import type { ResolvedLayer } from "./layers";
import type { BuddyPreset } from "./presets";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  rotV: number;
  phase: number;
  color: string;
};

type Range = [number, number];
const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const TAU = Math.PI * 2;

export function mountLayer(
  el: HTMLElement,
  layer: ResolvedLayer,
  preset?: BuddyPreset,
): () => void {
  const c = (preset?.config ?? {}) as Record<string, any>;
  const colors: Array<string> = layer.tint
    ? [layer.tint]
    : (c.colors ?? ["#ffffff"]);
  const shape: string = c.shape ?? "circle";
  const spawn: string = c.spawn ?? "full";
  const baseCount: number = c.count ?? 30;
  const vxR: Range = c.vx ?? [0, 0];
  const vyR: Range = c.vy ?? [0, 0];
  const gravity: number = c.gravity ?? 0;
  const sizeR: Range = c.size ?? [2, 4];
  const sway: { amp: number; freq: number } | null = c.sway ?? null;
  const twinkle: number = c.twinkle ?? 0;
  const flicker: number = c.flicker ?? 0;
  const rotate = !!c.rotate;
  const soft = !!c.soft;
  const glow = !!c.glow;
  const fadeTop = !!c.fadeTop;
  const randomWalk = !!c.randomWalk;
  const composite: GlobalCompositeOperation = (c.composite ??
    "source-over") as GlobalCompositeOperation;
  const base: string | null = c.base ?? null;
  const baseAlpha: number = c.opacity ?? 1;
  const speedMul = layer.speed * (c.speed ?? 1);

  let W = 0;
  let H = 0;
  let ps: Array<Particle> = [];

  function place(p: Particle, initial: boolean): void {
    p.color = colors[Math.floor(Math.random() * colors.length)];
    p.size = rand(sizeR[0], sizeR[1]);
    p.phase = Math.random() * TAU;
    p.vx = rand(vxR[0], vxR[1]) * speedMul;
    p.vy = rand(vyR[0], vyR[1]) * speedMul;
    p.rot = Math.random() * TAU;
    p.rotV = rotate ? rand(-3, 3) : 0;
    const m = p.size + 24;
    if (initial) {
      p.x = rand(0, W);
      p.y =
        spawn === "bottom"
          ? rand(H * 0.55, H + m)
          : spawn === "top"
            ? rand(-m, H * 0.45)
            : rand(0, H);
    } else if (spawn === "bottom") {
      p.x = rand(0, W);
      p.y = H + m;
    } else if (spawn === "top") {
      p.x = rand(0, W);
      p.y = -m;
    } else if (Math.abs(p.vx) >= Math.abs(p.vy)) {
      p.x = p.vx < 0 ? W + m : -m;
      p.y = rand(0, H);
    } else {
      p.x = rand(0, W);
      p.y = p.vy < 0 ? H + m : -m;
    }
  }

  function reseed(w: number, h: number): void {
    W = w;
    H = h;
    const area = clamp(w * h) / (260 * 260);
    const n = Math.max(
      1,
      Math.round(baseCount * layer.density * clampScale(area)),
    );
    ps = new Array(n);
    for (let i = 0; i < n; i++) {
      const p: Particle = {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        size: 0,
        rot: 0,
        rotV: 0,
        phase: 0,
        color: colors[0],
      };
      place(p, true);
      ps[i] = p;
    }
  }

  const step: CanvasStep = (ctx, w, h, t, dt) => {
    if (w !== W || h !== H || ps.length === 0) reseed(w, h);
    if (base) {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = composite;
    for (const p of ps) {
      if (gravity) p.vy += gravity * dt;
      if (randomWalk) {
        p.vx = p.vx * 0.96 + rand(-1, 1) * 36 * speedMul * dt;
        p.vy = p.vy * 0.96 + rand(-1, 1) * 36 * speedMul * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (rotate) p.rot += p.rotV * dt;
      const m = p.size + 24;
      if (p.y < -m || p.y > h + m || p.x < -m || p.x > w + m) place(p, false);

      const drawX =
        p.x + (sway ? Math.sin(t * sway.freq * TAU + p.phase) * sway.amp : 0);
      let a = baseAlpha;
      if (twinkle) a *= 1 - twinkle * (0.5 + 0.5 * Math.sin(t * 3 + p.phase));
      if (flicker) a = baseAlpha * (0.55 + 0.45 * Math.sin(t * 14 + p.phase));
      if (fadeTop) a *= clamp01(p.y / (h * 0.85)); // fade out as it rises toward the top
      ctx.globalAlpha = clamp01(a);
      drawShape(ctx, shape, drawX, p.y, p.size, p.rot, p.color, soft, glow);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  };

  return mountCanvas(el, step, { onResize: reseed });
}

function clamp(n: number): number {
  return n > 0 ? n : 1;
}
function clampScale(area: number): number {
  return area < 0.4 ? 0.4 : area > 3 ? 3 : area;
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: string,
  x: number,
  y: number,
  s: number,
  rot: number,
  color: string,
  soft: boolean,
  glow: boolean,
): void {
  switch (shape) {
    case "star":
      star(ctx, x, y, s, rot, color);
      return;
    case "rect":
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.fillStyle = color;
      ctx.fillRect(-s * 0.6, -s * 0.4, s * 1.2, s * 0.8);
      ctx.restore();
      return;
    case "heart":
      heart(ctx, x, y, s, color);
      return;
    case "bubble":
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, s * 0.12);
      ctx.beginPath();
      ctx.arc(x, y, s, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha *= 0.7;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x - s * 0.35, y - s * 0.35, Math.max(0.6, s * 0.16), 0, TAU);
      ctx.fill();
      return;
    case "streak":
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - s);
      ctx.stroke();
      return;
    case "flake":
    case "circle":
    default:
      if (soft || glow) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, s);
        g.addColorStop(0, color);
        g.addColorStop(glow ? 0.5 : 1, glow ? color : withAlpha(color, 0));
        if (glow) g.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = color;
      }
      ctx.beginPath();
      ctx.arc(x, y, s, 0, TAU);
      ctx.fill();
      return;
  }
}

// A 4-point sparkle star.
function star(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  rot: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = color;
  ctx.beginPath();
  const inner = s * 0.28;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
    const a2 = a + TAU / 8;
    ctx.lineTo(Math.cos(a2) * inner, Math.sin(a2) * inner);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function heart(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 16, s / 16);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 5);
  ctx.bezierCurveTo(-8, -4, -14, 4, 0, 14);
  ctx.bezierCurveTo(14, 4, 8, -4, 0, 5);
  ctx.fill();
  ctx.restore();
}

function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
