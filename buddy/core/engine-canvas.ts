// Shared canvas driver for the particle / painter / glyph engines. Owns the
// <canvas>, DPR sizing, the single rAF loop, pausing when hidden or off-screen,
// reduced-motion (one settled static frame, no loop), and jsdom-safety: when
// there is no 2D context it mounts and tears down cleanly without drawing.

const DPR_CAP = 2;

export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

function observeResize(
  el: HTMLElement,
  cb: () => void,
): (() => void) | undefined {
  if (typeof ResizeObserver === "undefined") return undefined;
  const ro = new ResizeObserver(() => cb());
  ro.observe(el);
  return () => ro.disconnect();
}

function observeIntersect(
  el: HTMLElement,
  cb: (visible: boolean) => void,
): (() => void) | undefined {
  if (typeof IntersectionObserver === "undefined") return undefined;
  const io = new IntersectionObserver((entries) =>
    cb(entries.some((e) => e.isIntersecting)),
  );
  io.observe(el);
  return () => io.disconnect();
}

/** A per-frame step: `t` seconds since mount, `dt` seconds since last frame. The
 *  canvas is cleared and reset (alpha 1, source-over) before each call. */
export type CanvasStep = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  dt: number,
) => void;

export type CanvasOpts = {
  /** Called with CSS-pixel size after each (re)size — e.g. to re-seed a field. */
  onResize?: (w: number, h: number) => void;
};

export function mountCanvas(
  el: HTMLElement,
  step: CanvasStep,
  opts: CanvasOpts = {},
): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = "buddy-avatar__layer-canvas";
  canvas.style.cssText = "width:100%;height:100%;display:block";
  el.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) return () => canvas.remove(); // jsdom / no-2d — graceful no-op

  let w = 0;
  let h = 0;
  function size(): void {
    const rect = el.getBoundingClientRect?.() ?? { width: 0, height: 0 };
    const dpr = Math.min(DPR_CAP, (globalThis.devicePixelRatio as number) || 1);
    w = Math.max(1, Math.round(rect.width));
    h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    opts.onResize?.(w, h);
  }
  size();

  function frameOnce(
    ctx2: CanvasRenderingContext2D,
    t: number,
    dt: number,
  ): void {
    ctx2.setTransform(
      Math.min(DPR_CAP, (globalThis.devicePixelRatio as number) || 1),
      0,
      0,
      Math.min(DPR_CAP, (globalThis.devicePixelRatio as number) || 1),
      0,
      0,
    );
    ctx2.globalAlpha = 1;
    ctx2.globalCompositeOperation = "source-over";
    ctx2.clearRect(0, 0, w, h);
    step(ctx2, w, h, t, dt);
  }

  // Reduced motion: settle ~2s of virtual time, leave the last frame, no loop.
  function settle(): void {
    ctx!.clearRect(0, 0, w, h);
    const dt = 1 / 60;
    for (let t = 0; t < 2; t += dt) {
      ctx!.globalAlpha = 1;
      ctx!.globalCompositeOperation = "source-over";
      if (t + dt >= 2) ctx!.clearRect(0, 0, w, h);
      step(ctx!, w, h, t, dt);
    }
  }

  if (prefersReducedMotion()) {
    settle();
    const ro = observeResize(el, () => {
      size();
      settle();
    });
    return () => {
      ro?.();
      canvas.remove();
    };
  }

  let raf = 0;
  let last = 0;
  let t = 0;
  let running = true;
  function loop(now: number): void {
    if (!running) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    t += dt;
    frameOnce(ctx!, t, dt);
    raf = requestAnimationFrame(loop);
  }
  function start(): void {
    if (running && raf) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(loop);
  }
  function stop(): void {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  raf = requestAnimationFrame(loop);

  const onVis = (): void => {
    if (typeof document !== "undefined" && document.hidden) stop();
    else start();
  };
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", onVis);
  const io = observeIntersect(el, (visible) => (visible ? start() : stop()));
  const ro = observeResize(el, size);

  return () => {
    stop();
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVis);
    io?.();
    ro?.();
    canvas.remove();
  };
}

// Deterministic per-index pseudo-random (no Math.random in draw loops).
export function seeded(i: number, salt = 0): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
