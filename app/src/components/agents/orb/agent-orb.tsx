import {
  AGENT_ORB_COLORS,
  AGENT_ORB_CSS,
  AGENT_ORB_GLOW,
  AGENT_ORB_LOOP_SECONDS,
  agentOrbDriftSeconds,
  agentOrbSizing,
} from "@openbot/shared/agent-orb";
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

/** Loud audio tightens the gradient, which reads as the orb "focusing". */
const AMPLITUDE_BLUR_FALLOFF = 0.45;
/** Amplitude adds at most 12% of extra size on top of the state scale. */
const AMPLITUDE_SCALE_GAIN = 0.12;
/** Single lateral nudge used to signal `error`, well under 200ms. */
const ERROR_SHAKE_KEYFRAMES = [0, -3, 3, 0];
const ERROR_SHAKE_DURATION = 0.18;
const EASE_IN_OUT = [0.645, 0.045, 0.355, 1] as const;
const {
  blurRatio: GLOW_BLUR_RATIO,
  insetRatio: GLOW_INSET_RATIO,
  maxOpacity: GLOW_MAX_OPACITY,
} = AGENT_ORB_GLOW;

/**
 * How far past its own box the orb paints, as a fraction of its size: the bloom's box, blurred
 * outward by its blur. Something that sits over the page right next to the orb, such as a sticky
 * header, cuts the glow flat unless this much room is left between them. The disc's own scale
 * (at most 1.1, plus the amplitude's 12%) stays well inside it.
 */
export const ORB_GLOW_REACH = GLOW_INSET_RATIO + GLOW_BLUR_RATIO;
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
  /**
   * Held still, as reduced motion holds it: for an orb nobody can see right now, such as a picture
   * scrolled off screen or in a hidden tab, so a loop nobody watches does not keep running.
   */
  still?: boolean;
  /**
   * Drawn in `colors` as given, in every state: for a Bot's orb, whose colors are how a person
   * tells that Bot from another. The state still sets how it moves, but never mutes it at rest or
   * turns its hue while it works.
   */
  trueColors?: boolean;
}

const AgentOrb: React.FC<AgentOrbProps> = ({
  size = "192px",
  className,
  colors,
  animationDuration = AGENT_ORB_LOOP_SECONDS,
  amplitude,
  state = "idle",
  still = false,
  trueColors = false,
}) => {
  const shouldReduceMotion = useReducedMotion() || still;
  const amplitudeValue = useAmplitudeValue(amplitude);
  const stateMotion = getAIStateMotion(state);

  const finalColors = { ...AGENT_ORB_COLORS, ...colors };
  // The bloom stays in the orb's own palette — see the note in ai-orb-aura.
  const glowColor = finalColors.c2;

  // Extract numeric value from size for calculations
  const sizeValue = Number.parseInt(size.replace("px", ""), 10);

  // Blur, contrast, dots, shadow, mask and rim all follow from the size.
  const {
    blur: blurAmount,
    contrast: finalContrast,
    dotSize,
    maskRadius,
    rim,
    shadowSpread,
  } = agentOrbSizing(sizeValue);

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

  const driftDuration = agentOrbDriftSeconds(stateMotion.speed);

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
          inset: `-${GLOW_INSET_RATIO * 100}%`,
        }}
        transition={shouldReduceMotion ? { duration: 0 } : SPRING_DEFAULT}
      />

      <motion.div
        className="agent-orb"
        data-still={still ? "" : undefined}
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
            filter: trueColors
              ? undefined
              : `saturate(${stateMotion.saturation}) hue-rotate(${stateMotion.hueRotate}deg)`,
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
        <style>{AGENT_ORB_CSS}</style>
      </motion.div>
    </motion.div>
  );
};

export default AgentOrb;
