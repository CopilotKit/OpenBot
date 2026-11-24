// Framework-agnostic types shared by the renderer and the pose controller.

export type NamePosition = "top" | "bottom" | "insetTop" | "insetBottom";
export type StatusPosition = NamePosition | "thoughtBubble";
export type ShadowLevel = "none" | "sm" | "md" | "lg" | "xl";

/** A label is either plain text or a caller-owned DOM node (framework content). */
export type LabelContent = string | number | Node | null | undefined;

// ---- Layers: animated backgrounds & effects --------------------------------
// App-supplied presentation composited inside the bubble (behind/around the
// character). Like `background`, layers never travel in the .buddy file.

export type LayerSlot = "backdrop" | "behind" | "front";
export type LayerAnchor = "cover" | "bottom" | "top" | "center";
export type LayerBlend =
  | "normal"
  | "screen"
  | "multiply"
  | "overlay"
  | "lighter";

export type BuddyLayer = {
  /** A preset id from the catalog. Exactly one of preset / src / css. */
  preset?: string;
  /** Media URL (video or image) — the caller-supplied escape hatch. */
  src?: string;
  /** Media kind; inferred from the file extension when omitted. */
  mediaType?: "video" | "image";
  /** A CSS `background` value painted on the layer element (animated gradients
   *  included — pair with the stylesheet keyframes). */
  css?: string;
  /** Where the layer stacks. Default: the preset's slot, else 'backdrop' for css/src. */
  slot?: LayerSlot;
  /** Layout inside the bubble. Default 'cover'. 'bottom'/'top' pin the layer to
   *  that edge at `height` of the bubble's height. */
  anchor?: LayerAnchor;
  /** Fraction of bubble height for anchored layers (0..1). Default per preset. */
  height?: number;
  blend?: LayerBlend;
  /** 0..1, default 1. */
  opacity?: number;
  /** Particle/painter tuning, preset-relative multipliers (default 1). */
  density?: number;
  speed?: number;
  /** Tint for particle presets that support it (sparkles, confetti, snow…). */
  tint?: string;
};

/** The 10 animated-background presets (cover the whole bubble, slot `backdrop`). */
export type BackgroundPresetId =
  | "aurora"
  | "starfield"
  | "nebula"
  | "sunset-clouds"
  | "underwater"
  | "synthwave"
  | "rainy-window"
  | "forest-dapple"
  | "bokeh"
  | "ocean";
/** The 10 effect presets (glyphs ship as two ids sharing one engine). */
export type EffectPresetId =
  | "sparkles"
  | "flames"
  | "disco"
  | "confetti"
  | "snow"
  | "rain"
  | "fireflies"
  | "hearts"
  | "bubbles"
  | "glyphs-z"
  | "glyphs-music";
export type BuddyPresetId = BackgroundPresetId | EffectPresetId;

export type BuddyAvatarRenderProps = {
  /** Pose clip to play. Takes priority over `avatarUrl`. */
  videoSrc?: string | null;
  /** Static image shown when there's no `videoSrc`. */
  avatarUrl?: string | null;
  /** Remount key for the video — change it (e.g. to the pose id) to restart. */
  poseKey?: string | number | null;
  /** Loop the clip? Idle/ambient poses loop; one-shot actions don't. */
  loop?: boolean;
  /** Fires when a non-looping clip finishes. */
  onEnded?: (() => void) | null;
  /** Fixed square size in px. Omit for a responsive, full-width bubble. */
  size?: number | null;
  /** Cap for the responsive (no `size`) bubble, in px. */
  maxSize?: number | null;
  /** Drop-shadow level for the bubble. Default `lg`. */
  shadow?: ShadowLevel;
  /** CSS background painted on the bubble behind the avatar — any CSS
   * `background` value (color, gradient, `url(...)` shorthand). For a
   * transparent buddy this is what shows through the alpha. null/undefined ⇒ the
   * `--buddy-bg` CSS variable applies (the stylesheet default). */
  background?: string | null;
  /** Alt text for the static avatar image. */
  alt?: string;
  /** Name label (text or a DOM node). Omit/null to hide. */
  name?: LabelContent;
  namePosition?: NamePosition;
  /** Status label (text or a DOM node). Omit/null to hide. */
  status?: LabelContent;
  statusPosition?: StatusPosition;
  /** Overlay node placed inside the bubble (badges, captions…). */
  overlay?: Node | null;
  /** Animated background / effect layers composited inside the bubble. */
  layers?: Array<BuddyLayer> | null;
  /** Extra class(es) on the root element. */
  className?: string;
};

/** Map of pose id → clip url. */
export type PoseClips = Record<string, string>;

/** Clips in either form the adapters accept: a pose→src map or an array of
 * `{ pose, src }`. Normalize to PoseClips with `toPoseClips`. */
export type BuddyClips =
  | Partial<Record<string, string>>
  | Array<{ pose: string; src: string }>;

/** The shared options shape the framework adapters wrap (React `useBuddy`,
 * Solid `createBuddy`, Vue `useBuddy`). */
export type BuddyOptions = {
  avatarUrl?: string | null;
  clips: BuddyClips;
  /** Resting pose; may change over time (the buddy follows it). */
  homePose?: string;
  /** Name used as the avatar's alt text. */
  name?: string;
  /** Background painted behind a (typically transparent) buddy — any CSS
   * `background` value. Threaded into the avatar render props by the adapters. */
  background?: string | null;
  /** Animated background / effect layers. Threaded into the render props by the adapters. */
  layers?: Array<BuddyLayer> | null;
};

export type SetPoseOptions = {
  /** Wait for the current (non-looping) clip to finish, then play this one. */
  queue?: boolean;
  /** Loop this pose until something changes it (default: only the home pose). */
  loop?: boolean;
  /** Return to the home pose after this many ms, regardless of clip length. */
  for?: number;
  /** When a non-looping clip ends, return home (default true for one-shots). */
  returnHome?: boolean;
};

export type BuddyControllerOptions = {
  clips: PoseClips;
  /** Resting pose; may change over time (the buddy follows it). Default idle→first. */
  homePose?: string;
  avatarUrl?: string | null;
};

export type BuddyControllerState = {
  /** Currently active pose. */
  pose: string;
  /** Resolved resting pose. */
  home: string;
  /** Clip url for the active pose (falls back to home). */
  videoSrc: string | null;
  avatarUrl: string | null;
  /** Remount key: `${pose}#${n}` — feed to the renderer's poseKey. */
  poseKey: string;
  loop: boolean;
};
