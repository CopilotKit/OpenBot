/**
 * OpenBot's orb, as the web app's `AgentOrb` (app/src/components/agents/orb/agent-orb.tsx) and the
 * Desktop setup window's mark both draw it: the palette, the values that follow from the orb's
 * size, the tempo of its loops, and its stylesheet. One copy, so the two never drift apart.
 *
 * The motion is CSS alone: four conic gradients turn off an `@property` angle and the sheen
 * drifts. The setup window has no motion library, and needs none to draw the same orb. Both loops
 * stop under reduced motion, and on an orb marked `data-still`.
 */

/** A ground and four mesh stops, set on the orb as `--bg` and `--c1` to `--c4`. */
export type AgentOrbColors = {
  bg: string;
  c1: string;
  c2: string;
  c3: string;
  /** Fourth mesh stop. More stops means fewer visible repeats per rotation. */
  c4: string;
};

/**
 * Higher chroma than the original pastels.
 *
 * The first palette sat at chroma 0.12–0.15, which washes out once the mesh is
 * blurred and the dot pattern is overlaid on top. Pushing to ~0.2 and adding a
 * saturate() pass to the mesh is what makes the colour survive all that.
 */
export const AGENT_ORB_COLORS: AgentOrbColors = {
  bg: "oklch(92% 0.03 300)",
  c1: "oklch(68% 0.21 350)", // Pink
  c2: "oklch(70% 0.18 210)", // Blue
  c3: "oklch(66% 0.2 285)", // Violet
  c4: "oklch(72% 0.19 325)", // Magenta, the fourth stop for variety
};

const SIZE_THRESHOLD_SMALL = 50;
const SIZE_THRESHOLD_TINY = 30;
const SIZE_THRESHOLD_MEDIUM = 100;
const BLUR_MULTIPLIER_SMALL = 0.008;
const BLUR_MIN_SMALL = 1;
const BLUR_MULTIPLIER_LARGE = 0.015;
const BLUR_MIN_LARGE = 4;
const CONTRAST_MULTIPLIER_SMALL = 0.004;
const CONTRAST_MIN_SMALL = 1.2;
const CONTRAST_MULTIPLIER_LARGE = 0.008;
const CONTRAST_MIN_LARGE = 1.5;
const DOT_SIZE_MULTIPLIER_SMALL = 0.004;
const DOT_SIZE_MIN_SMALL = 0.05;
const DOT_SIZE_MULTIPLIER_LARGE = 0.008;
const DOT_SIZE_MIN_LARGE = 0.1;
const SHADOW_MULTIPLIER_SMALL = 0.004;
const SHADOW_MIN_SMALL = 0.5;
const SHADOW_MULTIPLIER_LARGE = 0.008;
const SHADOW_MIN_LARGE = 2;
const MASK_RADIUS_TINY = "0%";
const MASK_RADIUS_SMALL = "5%";
const MASK_RADIUS_MEDIUM = "15%";
const MASK_RADIUS_LARGE = "25%";
const CONTRAST_TINY = 1.1;
const CONTRAST_MULTIPLIER_FINAL = 1.2;
const CONTRAST_MIN_FINAL = 1.3;
/** Depth rim, as a fraction of the orb size. */
const RIM_RATIO = 0.06;
const RIM_MIN = 1.5;
/** Sheen drift period at rest, before the state speed divides it. */
const DRIFT_BASE_SECONDS = 12;

/** The mesh's rotation period in seconds, before a state's speed divides it. */
export const AGENT_ORB_LOOP_SECONDS = 20;

/** How an orb in one of the app's states moves: the part of a state the orb's CSS can draw. */
export type AgentOrbMood = {
  /** Bloom strength, 0–1, before {@link AGENT_ORB_GLOW}'s `maxOpacity`. */
  readonly glow: number;
  /** Saturation over the disc. */
  readonly saturation: number;
  /** The disc's scale. */
  readonly scale: number;
  /** Divides the loops: 1 is the base tempo. */
  readonly speed: number;
};

/*
 * The app's `idle` and `listening` states (`AI_STATE_MOTION` in
 * app/src/components/agents/orb/ai-core.tsx), for an orb drawn without the app's states, such as
 * the Desktop setup window's mark. app/tests/agent-orb-shared.test.ts keeps them equal to the app's.
 */

/** The orb at rest: the app's `idle`. */
export const AGENT_ORB_AT_REST: AgentOrbMood = {
  glow: 0.15,
  saturation: 0.75,
  scale: 0.94,
  speed: 0.6,
};

/** The orb hearing someone: the app's `listening`. */
export const AGENT_ORB_LISTENING: AgentOrbMood = {
  glow: 0.6,
  saturation: 1.05,
  scale: 1.06,
  speed: 1,
};

/**
 * The bloom behind the disc, in the orb's own `--c2`: its box reaches `insetRatio` of the orb's size
 * past the orb's on every side, it is blurred by `blurRatio` of the size, and a state's `glow` is a
 * fraction of `maxOpacity`.
 */
export const AGENT_ORB_GLOW = {
  blurRatio: 0.28,
  insetRatio: 0.12,
  maxOpacity: 0.7,
} as const;

/** What the orb's size sets: how soft the mesh is, its contrast, the dots, the mask and the rim. */
export type AgentOrbSizing = {
  /** Mesh blur in px, before live audio tightens it. */
  blur: number;
  contrast: number;
  /** Dot pattern radius in px. */
  dotSize: number;
  /** The mask radius over the dot pattern; "0%" draws no mask. */
  maskRadius: string;
  /** Depth rim in px. */
  rim: number;
  /** Inner shadow spread in px. */
  shadowSpread: number;
};

/** The orb's size-dependent values, for a size in px. */
export function agentOrbSizing(sizeValue: number): AgentOrbSizing {
  const small = sizeValue < SIZE_THRESHOLD_SMALL;
  // Reduced blur, contrast, dots and shadow for small sizes.
  const blur = small
    ? Math.max(sizeValue * BLUR_MULTIPLIER_SMALL, BLUR_MIN_SMALL)
    : Math.max(sizeValue * BLUR_MULTIPLIER_LARGE, BLUR_MIN_LARGE);
  const contrastAmount = small
    ? Math.max(sizeValue * CONTRAST_MULTIPLIER_SMALL, CONTRAST_MIN_SMALL)
    : Math.max(sizeValue * CONTRAST_MULTIPLIER_LARGE, CONTRAST_MIN_LARGE);
  const dotSize = small
    ? Math.max(sizeValue * DOT_SIZE_MULTIPLIER_SMALL, DOT_SIZE_MIN_SMALL)
    : Math.max(sizeValue * DOT_SIZE_MULTIPLIER_LARGE, DOT_SIZE_MIN_LARGE);
  const shadowSpread = small
    ? Math.max(sizeValue * SHADOW_MULTIPLIER_SMALL, SHADOW_MIN_SMALL)
    : Math.max(sizeValue * SHADOW_MULTIPLIER_LARGE, SHADOW_MIN_LARGE);

  // Adjust mask radius based on size to reduce black center in small sizes
  let maskRadius = MASK_RADIUS_LARGE;
  if (sizeValue < SIZE_THRESHOLD_TINY) maskRadius = MASK_RADIUS_TINY;
  else if (small) maskRadius = MASK_RADIUS_SMALL;
  else if (sizeValue < SIZE_THRESHOLD_MEDIUM) maskRadius = MASK_RADIUS_MEDIUM;

  // Use more subtle contrast for very small sizes
  let contrast = contrastAmount;
  if (sizeValue < SIZE_THRESHOLD_TINY) contrast = CONTRAST_TINY;
  else if (small)
    contrast = Math.max(
      contrastAmount * CONTRAST_MULTIPLIER_FINAL,
      CONTRAST_MIN_FINAL,
    );

  // Rim thickness scales with the orb, so the lit edge reads the same at 24px
  // and at 240px instead of swallowing the small one.
  const rim = Math.max(sizeValue * RIM_RATIO, RIM_MIN);

  return { blur, contrast, dotSize, maskRadius, rim, shadowSpread };
}

/**
 * The sheen's drift period in seconds for a state's speed. The sheen drifts slower than the mesh
 * rotates; a busier state speeds it up a touch without matching the rotation, which would look
 * mechanical.
 */
export function agentOrbDriftSeconds(speed: number): number {
  return (DRIFT_BASE_SECONDS / (1 + speed)) * 2;
}

/**
 * The orb's stylesheet, for a `<style>` beside the orb. The disc is `.agent-orb`, with a sheen
 * (`.agent-orb-layer.agent-orb-sheen`) and a rim (`.agent-orb-layer.agent-orb-rim`) inside it, and
 * these custom properties on it: `--bg`, `--c1` to `--c4`, `--animation-duration`,
 * `--drift-duration`, `--blur-amount`, `--contrast-amount`, `--dot-size`, `--mask-radius`, `--rim`
 * and `--shadow-spread`.
 */
export const AGENT_ORB_CSS = `
        @property --angle {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }

        .agent-orb {
          display: grid;
          grid-template-areas: "stack";
          overflow: hidden;
          border-radius: 50%;
          position: relative;
          isolation: isolate;
        }

        .agent-orb::before,
        .agent-orb::after,
        .agent-orb > .agent-orb-layer {
          content: "";
          display: block;
          grid-area: stack;
          width: 100%;
          height: 100%;
          border-radius: 50%;
        }

        /* Glassy highlight that drifts, so the sheen never sits still enough to
           read as a printed-on gradient. */
        .agent-orb-sheen {
          background:
            radial-gradient(circle at 30% 24%, hsl(0 0% 100% / 0.32), transparent 34%),
            radial-gradient(circle at 72% 80%, hsl(0 0% 100% / 0.07), transparent 48%);
          mix-blend-mode: screen;
          animation: agent-drift var(--drift-duration) ease-in-out infinite alternate;
        }

        /* Lit top edge, shaded bottom, thin inner ring. */
        .agent-orb-rim {
          box-shadow:
            inset 0 0 0 1px hsl(0 0% 100% / 0.16),
            inset 0 calc(var(--rim) * 1) calc(var(--rim) * 2) hsl(0 0% 100% / 0.22),
            inset 0 calc(var(--rim) * -1.2) calc(var(--rim) * 2.4) hsl(0 0% 0% / 0.4);
          pointer-events: none;
        }

        @keyframes agent-drift {
          0% { transform: translate(-6%, -4%) scale(1.05); }
          100% { transform: translate(7%, 6%) scale(1.12); }
        }

        .agent-orb::before {
          background:
            conic-gradient(
              from calc(var(--angle) * 2) at 25% 70%,
              var(--c3),
              transparent 20% 80%,
              var(--c3)
            ),
            conic-gradient(
              from calc(var(--angle) * 2) at 45% 75%,
              var(--c2),
              transparent 30% 60%,
              var(--c2)
            ),
            conic-gradient(
              from calc(var(--angle) * -3) at 80% 20%,
              var(--c1),
              transparent 40% 60%,
              var(--c1)
            ),
            conic-gradient(
              from calc(var(--angle) * 1.5) at 60% 35%,
              var(--c4),
              transparent 25% 75%,
              var(--c4)
            ),
            conic-gradient(
              from calc(var(--angle) * 2) at 15% 5%,
              var(--c2),
              transparent 10% 90%,
              var(--c2)
            ),
            conic-gradient(
              from calc(var(--angle) * 1) at 20% 80%,
              var(--c1),
              transparent 10% 90%,
              var(--c1)
            ),
            conic-gradient(
              from calc(var(--angle) * -2) at 85% 10%,
              var(--c3),
              transparent 20% 80%,
              var(--c3)
            );
          box-shadow: inset var(--bg) 0 0 var(--shadow-spread)
            calc(var(--shadow-spread) * 0.2);
          /* The saturate() pass is what keeps the colour alive after the blur
             and the overlaid dot pattern have both eaten into it. */
          filter: blur(var(--blur-amount)) contrast(var(--contrast-amount))
            saturate(1.4);
          animation: rotate var(--animation-duration) linear infinite;
        }

        .agent-orb::after {
          background-image: radial-gradient(
            circle at center,
            var(--bg) var(--dot-size),
            transparent var(--dot-size)
          );
          background-size: calc(var(--dot-size) * 2) calc(var(--dot-size) * 2);
          backdrop-filter: blur(calc(var(--blur-amount) * 2))
            contrast(calc(var(--contrast-amount) * 2));
          mix-blend-mode: overlay;
        }

        /* Apply mask only when radius is greater than 0 */
        .agent-orb[style*="--mask-radius: 0%"]::after {
          mask-image: none;
        }

        .agent-orb:not([style*="--mask-radius: 0%"])::after {
          mask-image: radial-gradient(
            black var(--mask-radius),
            transparent 75%
          );
        }

        @keyframes rotate {
          to {
            --angle: 360deg;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .agent-orb::before,
          .agent-orb-sheen {
            animation: none;
          }
        }

        .agent-orb[data-still]::before,
        .agent-orb[data-still] .agent-orb-sheen {
          animation: none;
        }
      `;
