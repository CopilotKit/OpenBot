// Resolve a caller's layer list into flat, fully-defaulted layers the renderer
// can mount: expand macros, apply preset defaults under caller overrides, drop
// invalid entries (never throw — a bad layer is a dev warning and a no-op).

import { type BuddyPreset, getPreset } from "./presets";
import type {
  BuddyLayer,
  LayerAnchor,
  LayerBlend,
  LayerSlot,
} from "./types";

export type ResolvedLayer = {
  preset?: string;
  src?: string;
  css?: string;
  mediaType?: "video" | "image";
  slot: LayerSlot;
  anchor: LayerAnchor;
  height?: number;
  blend?: LayerBlend;
  opacity: number;
  density: number;
  speed: number;
  tint?: string;
  /** Stable identity for reconciliation — same input ⇒ same key. */
  key: string;
};

function devWarn(msg: string): void {
  const prod =
    (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
      ?.NODE_ENV === "production";
  if (!prod && typeof console !== "undefined")
    console.warn(`[buddy-core/layers] ${msg}`);
}

const VIDEO_EXT = /\.(mp4|webm|mov)(\?|#|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i;

function inferMediaType(
  src: string,
  explicit?: "video" | "image",
): "video" | "image" | undefined {
  if (explicit) return explicit;
  if (VIDEO_EXT.test(src)) return "video";
  if (IMAGE_EXT.test(src)) return "image";
  return undefined;
}

// Fold a preset's defaults under a stack of overrides. Structural fields take the
// last set value; density/speed are preset-relative multipliers that compose.
function build(
  preset: BuddyPreset | undefined,
  overrides: Array<Partial<BuddyLayer>>,
): ResolvedLayer {
  const r: ResolvedLayer = {
    preset: preset?.id,
    slot: preset?.slot ?? "backdrop",
    anchor: preset?.anchor ?? "cover",
    height: preset?.height,
    blend: preset?.blend,
    opacity: 1,
    density: 1,
    speed: 1,
    key: "",
  };
  for (const o of overrides) {
    if (o.slot != null) r.slot = o.slot;
    if (o.anchor != null) r.anchor = o.anchor;
    if (o.height != null) r.height = o.height;
    if (o.blend != null) r.blend = o.blend;
    if (o.opacity != null) r.opacity = o.opacity;
    if (o.tint != null) r.tint = o.tint;
    if (o.density != null) r.density *= o.density;
    if (o.speed != null) r.speed *= o.speed;
    if (o.src != null) r.src = o.src;
    if (o.css != null) r.css = o.css;
    if (o.mediaType != null) r.mediaType = o.mediaType;
  }
  if (r.src) r.mediaType = inferMediaType(r.src, r.mediaType);
  return r;
}

// The caller's tuning fields only (propagated into a macro's sub-layers so a
// caller can dim/speed a whole macro without clobbering its structure).
function tuningOf(layer: BuddyLayer): Partial<BuddyLayer> {
  return {
    density: layer.density,
    speed: layer.speed,
    tint: layer.tint,
    opacity: layer.opacity,
    blend: layer.blend,
  };
}

function serialize(r: ResolvedLayer): string {
  return JSON.stringify([
    r.preset ?? "",
    r.src ?? "",
    r.css ?? "",
    r.mediaType ?? "",
    r.slot,
    r.anchor,
    r.height ?? "",
    r.blend ?? "",
    r.opacity,
    r.density,
    r.speed,
    r.tint ?? "",
  ]);
}

export function resolveLayers(
  layers: Array<BuddyLayer> | null | undefined,
): Array<ResolvedLayer> {
  if (!layers || !layers.length) return [];
  const out: Array<ResolvedLayer> = [];

  for (const layer of layers) {
    const set = [layer.preset, layer.src, layer.css].filter(
      (v) => v != null && v !== "",
    );
    if (set.length !== 1) {
      devWarn(
        `layer must set exactly one of preset/src/css (got ${set.length}) — dropped`,
      );
      continue;
    }
    if (layer.preset != null && layer.preset !== "") {
      const preset = getPreset(layer.preset);
      if (!preset) {
        devWarn(`unknown preset "${layer.preset}" — dropped`);
        continue;
      }
      if (preset.engine === "macro") {
        const tuning = tuningOf(layer);
        for (const sub of preset.expand ?? []) {
          const subPreset = sub.preset ? getPreset(sub.preset) : undefined;
          out.push(build(subPreset, [sub, tuning]));
        }
      } else {
        out.push(build(preset, [layer]));
      }
    } else {
      // src / css: no preset; defaults slot 'backdrop', anchor 'cover'.
      out.push(build(undefined, [layer]));
    }
  }

  // Stable keys: content + occurrence index (so duplicate layers stay distinct
  // and an unchanged list keeps every key — hence its canvas/video — across updates).
  const seen = new Map<string, number>();
  for (const r of out) {
    const base = serialize(r);
    const i = seen.get(base) ?? 0;
    seen.set(base, i + 1);
    r.key = `${base}#${i}`;
  }
  return out;
}
