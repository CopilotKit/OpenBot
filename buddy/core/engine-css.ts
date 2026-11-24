// CSS/DOM engine — sets classes/markup only, no canvas. Currently the disco
// ball: a hanging faceted ball built from DOM elements with a slow CSS shine
// sweep (keyframes in styles.ts, gated behind prefers-reduced-motion). No image
// assets.
import type { ResolvedLayer } from "./layers.ts";
import type { BuddyPreset } from "./presets.ts";

export function mountLayer(
  el: HTMLElement,
  _layer: ResolvedLayer,
  preset?: BuddyPreset,
): () => void {
  const variant = (preset?.config as Record<string, unknown>)?.variant;
  if (variant === "disco-ball") {
    const wrap = document.createElement("div");
    wrap.className = "buddy-avatar__disco";
    const line = document.createElement("span");
    line.className = "buddy-avatar__disco-line";
    const ball = document.createElement("span");
    ball.className = "buddy-avatar__disco-ball";
    wrap.appendChild(line);
    wrap.appendChild(ball);
    el.appendChild(wrap);
    return () => wrap.remove();
  }
  return () => {};
}
