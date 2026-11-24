// Canvas text-glyph particles (Sleep Zzz / Music Notes). Glyphs spawn in the
// top-right area, rise with a gentle sway, scale 0.8→1.2, and fade in/out. Drawn
// as canvas text so there is no emoji-font dependency ("Z", "♪" render anywhere).
import { type CanvasStep, mountCanvas } from "./engine-canvas.ts";
import type { ResolvedLayer } from "./layers.ts";
import type { BuddyPreset } from "./presets.ts";

type Glyph = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  char: string;
  color: string;
  size: number;
};

export function mountLayer(
  el: HTMLElement,
  layer: ResolvedLayer,
  preset?: BuddyPreset,
): () => void {
  const c = (preset?.config ?? {}) as Record<string, any>;
  const glyphs: Array<string> = c.glyphs ?? ["Z", "z"];
  const colors: Array<string> = layer.tint
    ? [layer.tint]
    : (c.colors ?? ["#cfe0ff"]);
  const baseSize: number = c.size ?? 16;
  const count = Math.max(2, Math.round((c.count ?? 6) * layer.density));
  const speed = layer.speed;

  let W = 0;
  let H = 0;
  let gs: Array<Glyph> = [];

  function spawn(g: Glyph, initial: boolean): void {
    g.char = glyphs[Math.floor(Math.random() * glyphs.length)];
    g.color = colors[Math.floor(Math.random() * colors.length)];
    g.size = baseSize + Math.random() * 6;
    g.x = W * (0.6 + 0.32 * Math.random());
    g.y = initial
      ? H * (0.25 + 0.6 * Math.random())
      : H * (0.6 + 0.3 * Math.random());
    g.vx = (-6 + Math.random() * 3) * speed;
    g.vy = (-16 - Math.random() * 10) * speed;
    g.age = initial ? Math.random() * 2 : 0;
    g.life = 2.2 + Math.random() * 1.3;
  }

  function reseed(w: number, h: number): void {
    W = w;
    H = h;
    gs = Array.from({ length: count }, () => {
      const g: Glyph = {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        age: 0,
        life: 1,
        char: glyphs[0],
        color: colors[0],
        size: baseSize,
      };
      spawn(g, true);
      return g;
    });
  }

  const step: CanvasStep = (ctx, w, h, t, dt) => {
    if (w !== W || h !== H || gs.length === 0) reseed(w, h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const g of gs) {
      g.age += dt;
      g.x += g.vx * dt + Math.sin(t * 2 + g.y * 0.05) * 5 * dt;
      g.y += g.vy * dt;
      if (g.age > g.life || g.y < -24) spawn(g, false);
      const p = g.age / g.life;
      const scale = 0.8 + 0.4 * p;
      const alpha = p < 0.15 ? p / 0.15 : p > 0.7 ? (1 - p) / 0.3 : 1;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.fillStyle = g.color;
      ctx.font = `600 ${(g.size * scale).toFixed(1)}px system-ui, sans-serif`;
      ctx.fillText(g.char, g.x, g.y);
    }
    ctx.globalAlpha = 1;
  };

  return mountCanvas(el, step, { onResize: reseed });
}
