import {
  type MotionStyle,
  motion,
  type TargetAndTransition,
  type Transition,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { cn } from "@/lib/utils";
import {
  type AIAmplitude,
  type AIState,
  getAIStateMotion,
  useAmplitudeValue,
} from "./ai-core";

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

/** Loud audio tightens the gradient, which reads as the orb "focusing". */
const AMPLITUDE_BLUR_FALLOFF = 0.45;
/** Amplitude adds at most 12% of extra size on top of the state scale. */
const AMPLITUDE_SCALE_GAIN = 0.12;
/** Single lateral nudge used to signal `error`, well under 200ms. */
const ERROR_SHAKE_KEYFRAMES = [0, -3, 3, 0];
const ERROR_SHAKE_DURATION = 0.18;
const EASE_IN_OUT = [0.645, 0.045, 0.355, 1] as const;
const GLOW_BLUR_RATIO = 0.28;
const GLOW_MAX_OPACITY = 0.7;
/** Depth rim, as a fraction of the orb size. */
const RIM_RATIO = 0.06;
const RIM_MIN = 1.5;
/** Sheen drift period at rest, before the state speed divides it. */
const DRIFT_BASE_SECONDS = 12;
/** `idle` breathes: a slow, shallow scale cycle that never draws attention. */
const BREATHE_SCALE = [1, 1.035, 1];
const BREATHE_SECONDS = 5.5;
const SPRING_DEFAULT: Transition = {
  bounce: 0.1,
  duration: 0.25,
  type: "spring",
};

export interface AgentOrbProps {
  /**
   * Live audio level, 0–1. Pass the `MotionValue` from `useAudioAmplitude` so
   * the signal never re-renders React.
   */
  amplitude?: AIAmplitude;
  /** Ambient rotation period in seconds, before the state speed multiplier. */
  animationDuration?: number;
  className?: string;
  colors?: {
    bg?: string;
    c1?: string;
    c2?: string;
    c3?: string;
    /** Fourth mesh stop. More stops means fewer visible repeats per rotation. */
    c4?: string;
  };
  size?: string;
  /** Shared AI state driving speed, scale, saturation and reactivity. */
  state?: AIState;
}

const AgentOrb: React.FC<AgentOrbProps> = ({
  size = "192px",
  className,
  colors,
  animationDuration = 20,
  amplitude,
  state = "idle",
}) => {
  const shouldReduceMotion = useReducedMotion();
  const amplitudeValue = useAmplitudeValue(amplitude);
  const stateMotion = getAIStateMotion(state);

  /**
   * Higher chroma than the original pastels.
   *
   * The first palette sat at chroma 0.12–0.15, which washes out once the mesh is
   * blurred and the dot pattern is overlaid on top. Pushing to ~0.2 and adding a
   * saturate() pass to the mesh is what makes the colour survive all that.
   */
  const defaultColors = {
    bg: "oklch(92% 0.03 300)",
    c1: "oklch(68% 0.21 350)", // Pink
    c2: "oklch(70% 0.18 210)", // Blue
    c3: "oklch(66% 0.2 285)", // Violet
    c4: "oklch(72% 0.19 325)", // Magenta, the fourth stop for variety
  };

  const finalColors = { ...defaultColors, ...colors };
  // The bloom stays in the orb's own palette — see the note in ai-orb-aura.
  const glowColor = finalColors.c2;

  // Extract numeric value from size for calculations
  const sizeValue = Number.parseInt(size.replace("px", ""), 10);

  // Responsive calculations based on size
  const blurAmount =
    sizeValue < SIZE_THRESHOLD_SMALL
      ? Math.max(sizeValue * BLUR_MULTIPLIER_SMALL, BLUR_MIN_SMALL) // Reduced blur for small sizes
      : Math.max(sizeValue * BLUR_MULTIPLIER_LARGE, BLUR_MIN_LARGE);

  const contrastAmount =
    sizeValue < SIZE_THRESHOLD_SMALL
      ? Math.max(sizeValue * CONTRAST_MULTIPLIER_SMALL, CONTRAST_MIN_SMALL) // Reduced contrast for small sizes
      : Math.max(sizeValue * CONTRAST_MULTIPLIER_LARGE, CONTRAST_MIN_LARGE);

  const dotSize =
    sizeValue < SIZE_THRESHOLD_SMALL
      ? Math.max(sizeValue * DOT_SIZE_MULTIPLIER_SMALL, DOT_SIZE_MIN_SMALL) // Smaller dots for small sizes
      : Math.max(sizeValue * DOT_SIZE_MULTIPLIER_LARGE, DOT_SIZE_MIN_LARGE);

  const shadowSpread =
    sizeValue < SIZE_THRESHOLD_SMALL
      ? Math.max(sizeValue * SHADOW_MULTIPLIER_SMALL, SHADOW_MIN_SMALL) // Reduced shadow for small sizes
      : Math.max(sizeValue * SHADOW_MULTIPLIER_LARGE, SHADOW_MIN_LARGE);

  // Adjust mask radius based on size to reduce black center in small sizes
  const getMaskRadius = (value: number) => {
    if (value < SIZE_THRESHOLD_TINY) {
      return MASK_RADIUS_TINY;
    }
    if (value < SIZE_THRESHOLD_SMALL) {
      return MASK_RADIUS_SMALL;
    }
    if (value < SIZE_THRESHOLD_MEDIUM) {
      return MASK_RADIUS_MEDIUM;
    }
    return MASK_RADIUS_LARGE;
  };

  const maskRadius = getMaskRadius(sizeValue);

  // Use more subtle contrast for very small sizes
  const getFinalContrast = (value: number) => {
    if (value < SIZE_THRESHOLD_TINY) {
      return CONTRAST_TINY; // Very subtle contrast for tiny sizes
    }
    if (value < SIZE_THRESHOLD_SMALL) {
      return Math.max(
        contrastAmount * CONTRAST_MULTIPLIER_FINAL,
        CONTRAST_MIN_FINAL,
      ); // Reduced contrast for small sizes
    }
    return contrastAmount;
  };

  const finalContrast = getFinalContrast(sizeValue);

  // Reactivity is gated by the state preset: `thinking` barely listens so the
  // orb keeps churning internally instead of throbbing with room noise.
  const reactivity = shouldReduceMotion ? 0 : stateMotion.reactivity;

  const reactiveBlur = useTransform(amplitudeValue, (level) => {
    const focus = 1 - level * reactivity * AMPLITUDE_BLUR_FALLOFF;
    return `${blurAmount * focus}px`;
  });

  const reactiveScale = useTransform(
    amplitudeValue,
    (level) => stateMotion.scale + level * reactivity * AMPLITUDE_SCALE_GAIN,
  );

  const loopDuration = shouldReduceMotion
    ? animationDuration
    : animationDuration / stateMotion.speed;

  // Rim thickness scales with the orb, so the lit edge reads the same at 24px
  // and at 240px instead of swallowing the small one.
  const rim = Math.max(sizeValue * RIM_RATIO, RIM_MIN);
  // The sheen drifts slower than the mesh rotates; a busier state speeds it up
  // a touch without matching the rotation, which would look mechanical.
  const driftDuration = (DRIFT_BASE_SECONDS / (1 + stateMotion.speed)) * 2;

  const getRootAnimate = (): TargetAndTransition => {
    if (shouldReduceMotion) {
      return { scale: 1, x: 0 };
    }
    if (state === "error") {
      return { scale: 1, x: ERROR_SHAKE_KEYFRAMES };
    }
    if (stateMotion.motif === "breathe") {
      return { scale: BREATHE_SCALE, x: 0 };
    }
    return { scale: 1, x: 0 };
  };

  const getRootTransition = (): Transition => {
    if (shouldReduceMotion) {
      return { duration: 0 };
    }
    if (state === "error") {
      return { duration: ERROR_SHAKE_DURATION, ease: EASE_IN_OUT };
    }
    if (stateMotion.motif === "breathe") {
      return {
        duration: BREATHE_SECONDS,
        ease: EASE_IN_OUT,
        repeat: Number.POSITIVE_INFINITY,
      };
    }
    return SPRING_DEFAULT;
  };

  return (
    // The gradient disc clips its own overflow, so the bloom and the status
    // motif have to live in a wrapper rather than inside it.
    <motion.div
      animate={getRootAnimate()}
      className={cn("relative", className)}
      style={
        {
          "--orb-size": size,
          height: size,
          width: size,
        } as MotionStyle
      }
      transition={getRootTransition()}
    >
      {/* Bloom tinted by the state's semantic accent. */}
      <motion.div
        animate={{ opacity: stateMotion.glow * GLOW_MAX_OPACITY }}
        className="absolute rounded-full"
        style={{
          background: `radial-gradient(circle at 50% 50%, ${glowColor} 0%, transparent 64%)`,
          filter: `blur(calc(var(--orb-size) * ${GLOW_BLUR_RATIO}))`,
          inset: "-12%",
        }}
        transition={shouldReduceMotion ? { duration: 0 } : SPRING_DEFAULT}
      />

      <motion.div
        className="agent-orb"
        style={
          {
            "--animation-duration": `${loopDuration}s`,
            "--bg": finalColors.bg,
            "--blur-amount": reactiveBlur,
            "--c1": finalColors.c1,
            "--c2": finalColors.c2,
            "--c3": finalColors.c3,
            "--c4": finalColors.c4,
            "--contrast-amount": finalContrast,
            "--dot-size": `${dotSize}px`,
            "--drift-duration": `${driftDuration}s`,
            "--mask-radius": maskRadius,
            "--rim": `${rim}px`,
            "--shadow-spread": `${shadowSpread}px`,
            // Saturation and hue only affect the gradient disc. Applying them
            // to the whole component would desaturate the semantic accent too,
            // and `error` would lose the very red that identifies it.
            filter: `saturate(${stateMotion.saturation}) hue-rotate(${stateMotion.hueRotate}deg)`,
            height: "100%",
            scale: reactiveScale,
            width: "100%",
          } as MotionStyle
        }
      >
        {/* Specular sheen and depth rim. The mesh alone reads as a flat blurred
            disc; a drifting highlight plus a lit top edge and shaded bottom are
            what make it read as a sphere. */}
        <span aria-hidden="true" className="agent-orb-layer agent-orb-sheen" />
        <span aria-hidden="true" className="agent-orb-layer agent-orb-rim" />
        <style>{`
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
      `}</style>
      </motion.div>
    </motion.div>
  );
};

export default AgentOrb;
