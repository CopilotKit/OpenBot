// Canvas-2D painter scenes (one small draw function per painter id). Each
// receives (ctx, w, h, t, dt); stateless except where noted (rainy-window keeps
// droplet state; nebula/clouds derive positions from seeded pseudo-random by
// index — deterministic, no Math.random in the draw loop).
import { type CanvasStep, mountCanvas, seeded } from "./engine-canvas.ts";
import type { ResolvedLayer } from "./layers.ts";
import type { BuddyPreset } from "./presets.ts";

const TAU = Math.PI * 2;
type Painter = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  dt: number,
) => void;

export function mountLayer(
  el: HTMLElement,
  layer: ResolvedLayer,
  preset?: BuddyPreset,
): () => void {
  const id = ((preset?.config as Record<string, unknown>)?.painter ??
    "aurora") as string;
  const draw = makePainter(id, layer.speed);
  const step: CanvasStep = (ctx, w, h, t, dt) => draw(ctx, w, h, t, dt);
  return mountCanvas(el, step);
}

function vgrad(
  ctx: CanvasRenderingContext2D,
  h: number,
  a: string,
  b: string,
  mid?: string,
): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, a);
  if (mid) g.addColorStop(0.5, mid);
  g.addColorStop(1, b);
  return g;
}

function makePainter(id: string, speed: number): Painter {
  switch (id) {
    case "aurora":
      return (ctx, w, h, t) => {
        const ts = t * speed;
        ctx.fillStyle = vgrad(ctx, h, "#0a1033", "#02030f");
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "lighter";
        const cols = ["#3df5a0", "#8a5cff", "#39d0ff"];
        for (let i = 0; i < 3; i++) {
          const yBase =
            h * (0.32 + 0.16 * i) + Math.sin(ts * 0.4 + i) * h * 0.05;
          const grad = ctx.createLinearGradient(
            0,
            yBase - h * 0.16,
            0,
            yBase + h * 0.16,
          );
          grad.addColorStop(0, "rgba(0,0,0,0)");
          grad.addColorStop(0.5, cols[i]);
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.globalAlpha = 0.45;
          ctx.beginPath();
          ctx.moveTo(0, yBase - h * 0.16);
          for (let x = 0; x <= w; x += 8)
            ctx.lineTo(
              x,
              yBase + Math.sin(x * 0.02 + ts * 0.8 + i * 2) * h * 0.06,
            );
          ctx.lineTo(w, yBase + h * 0.16);
          ctx.lineTo(0, yBase + h * 0.16);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      };
    case "nebula":
      return (ctx, w, h, t) => {
        const ts = t * speed;
        ctx.fillStyle = "#05030d";
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "lighter";
        const cols = [
          "#5a3df5",
          "#c23df5",
          "#3d7bf5",
          "#f53d9e",
          "#6a3df5",
          "#f55d9e",
        ];
        for (let i = 0; i < 6; i++) {
          const cx =
            (0.2 + 0.6 * seeded(i, 1)) * w + Math.sin(ts * 0.2 + i) * w * 0.06;
          const cy =
            (0.2 + 0.6 * seeded(i, 2)) * h + Math.cos(ts * 0.17 + i) * h * 0.06;
          const r =
            (0.26 + 0.18 * seeded(i, 3)) *
            Math.min(w, h) *
            (1 + 0.12 * Math.sin(ts * 0.5 + i));
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, cols[i]);
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      };
    case "sunset-clouds":
      return (ctx, w, h, t) => {
        const ts = t * speed;
        ctx.fillStyle = vgrad(ctx, h, "#ffd08a", "#8a4a8f", "#ff8f6b");
        ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 5; i++) {
          const cy = (0.3 + 0.5 * seeded(i, 1)) * h;
          const cx =
            ((seeded(i, 2) * w + ts * 12 * (0.5 + seeded(i, 3))) % (w + 160)) -
            80;
          const rw = (0.22 + 0.16 * seeded(i, 4)) * w;
          const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rw);
          gr.addColorStop(0, "rgba(255,240,230,0.5)");
          gr.addColorStop(1, "rgba(255,240,230,0)");
          ctx.fillStyle = gr;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.scale(1, 0.4);
          ctx.beginPath();
          ctx.arc(0, 0, rw, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
      };
    case "underwater":
      return (ctx, w, h, t) => {
        const ts = t * speed;
        ctx.fillStyle = vgrad(ctx, h, "#1a6ea8", "#07263f");
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 2; i++) {
          const ang = -0.5 + 0.25 * Math.sin(ts * 0.3 + i * 2) + i * 0.55;
          ctx.save();
          ctx.translate(w * (0.3 + 0.4 * i), -10);
          ctx.rotate(ang);
          const gr = ctx.createLinearGradient(0, 0, 0, h * 1.4);
          gr.addColorStop(0, "rgba(190,235,255,0.20)");
          gr.addColorStop(1, "rgba(190,235,255,0)");
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.moveTo(-w * 0.08, 0);
          ctx.lineTo(w * 0.08, 0);
          ctx.lineTo(w * 0.28, h * 1.4);
          ctx.lineTo(-w * 0.28, h * 1.4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        ctx.globalCompositeOperation = "source-over";
      };
    case "synthwave":
      return (ctx, w, h, t) => {
        const ts = t * speed;
        const horizon = h * 0.6;
        ctx.fillStyle = vgrad(ctx, h, "#1a0533", "#5a1a6e");
        ctx.fillRect(0, 0, w, h);
        const sunR = w * 0.18;
        const sx = w * 0.5;
        const sy = horizon - sunR * 0.3;
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, sunR, 0, TAU);
        ctx.clip();
        const sg = ctx.createLinearGradient(0, sy - sunR, 0, sy + sunR);
        sg.addColorStop(0, "#ffe36b");
        sg.addColorStop(1, "#ff5db0");
        ctx.fillStyle = sg;
        ctx.fillRect(sx - sunR, sy - sunR, sunR * 2, sunR * 2);
        ctx.fillStyle = "#1a0533";
        for (let i = 0; i < 6; i++)
          ctx.fillRect(
            sx - sunR,
            sy + sunR * 0.2 + i * sunR * 0.15,
            sunR * 2,
            sunR * 0.05 * (1 + i * 0.5),
          );
        ctx.restore();
        ctx.strokeStyle = "rgba(255,80,200,0.5)";
        ctx.lineWidth = 1;
        for (let i = -10; i <= 10; i++) {
          ctx.beginPath();
          ctx.moveTo(w * 0.5, horizon);
          ctx.lineTo(w * 0.5 + i * w * 0.12, h);
          ctx.stroke();
        }
        const scroll = (ts * 0.5) % 1;
        for (let i = 0; i < 12; i++) {
          const f = (i + scroll) / 12;
          const y = horizon + (h - horizon) * f * f;
          ctx.globalAlpha = f;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      };
    case "ocean":
      return (ctx, w, h, t) => {
        const ts = t * speed;
        ctx.fillStyle = vgrad(ctx, h, "#2fd3c7", "#0a5a6e");
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 5; i++) {
          const yb = h * (0.15 + i * 0.16);
          ctx.strokeStyle = `rgba(220,255,250,${Math.max(0.04, 0.18 * (1 - i * 0.15))})`;
          ctx.lineWidth = Math.max(2, h * 0.03);
          ctx.beginPath();
          for (let x = 0; x <= w; x += 6) {
            const y = yb + Math.sin(x * 0.03 + ts * 1.2 + i) * h * 0.02;
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.globalCompositeOperation = "source-over";
      };
    case "forest-dapple":
      return (ctx, w, h) => {
        ctx.fillStyle = vgrad(ctx, h, "#2f7a3a", "#123a1c");
        ctx.fillRect(0, 0, w, h);
      };
    case "rainy-window":
      return rainyWindow(speed);
    default:
      return (ctx, w, h) => {
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, w, h);
      };
  }
}

function rainyWindow(speed: number): Painter {
  type Drop = { x: number; y: number; r: number; vy: number };
  let drops: Array<Drop> = [];
  let W = 0;
  let H = 0;
  const newDrop = (w: number, h: number, initial: boolean): Drop => ({
    x: Math.random() * w,
    y: initial ? Math.random() * h : -8,
    r: 1.5 + Math.random() * 3.5,
    vy: 0,
  });
  return (ctx, w, h, _t, dt) => {
    if (w !== W || h !== H) {
      W = w;
      H = h;
      drops = Array.from({ length: 16 }, () => newDrop(w, h, true));
    }
    ctx.fillStyle = vgrad(ctx, h, "#5a7a8a", "#34505c");
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 0.22;
    const washCols = ["#9ad0ff", "#ffd3a1", "#c7a9ff", "#a1ffd3"];
    for (let i = 0; i < 4; i++) {
      const cx = (0.25 + 0.5 * seeded(i, 1)) * w;
      const cy = (0.2 + 0.6 * seeded(i, 2)) * h;
      const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.32);
      gr.addColorStop(0, washCols[i]);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(232,246,255,0.6)";
    const s = speed;
    for (const d of drops) {
      d.r += dt * s * 1.1;
      if (d.r > 5) d.vy += dt * s * 70;
      d.y += d.vy * dt * s;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, TAU);
      ctx.fill();
      if (d.y > h + 10) Object.assign(d, newDrop(w, h, false));
    }
  };
}
