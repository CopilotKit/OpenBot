"use client";

import {
  type MotionValue,
  useAnimationFrame,
  useMotionValue,
} from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The single state contract shared by every SmoothUI AI component.
 *
 * Passing the same value to an orb, a prompt input and a tool card makes the
 * whole surface move as one organism instead of a set of independent widgets.
 */
export type AIState =
  | "idle"
  | "listening"
  | "thinking"
  | "streaming"
  | "done"
  | "error";

/**
 * A behavioural hint each component expresses **in its own material**.
 *
 * Deliberately not an overlay. Bolting one shared graphic onto every orb makes
 * four different materials look like the same widget wearing a costume, and it
 * pushes literal iconography (a checkmark, a warning ring) onto pieces that are
 * decorative by nature. Instead: a shader warps, a canvas ring loses harmonics,
 * a character changes expression. Same vocabulary, different flesh.
 */
export type AIStateMotif =
  | "breathe"
  | "receive"
  | "scan"
  | "pulse"
  | "ping"
  | "fault";

/** Semantic accent applied on top of the component's own palette. */
export type AIStateAccent = "success" | "danger" | null;

/** Motion parameters a component reads to render a given {@link AIState}. */
export type AIStateMotion = {
  /** Semantic colour override, so status is carried by hue and not only motion. */
  accent: AIStateAccent;
  /** Outer bloom strength, 0–1. */
  glow: number;
  /** Palette hue rotation in degrees. Small shifts read as a mood change. */
  hueRotate: number;
  /** Overall motion energy, 0–1. Scales ambient loops and displacement. */
  intensity: number;
  /** Behavioural hint; each component expresses it in its own material. */
  motif: AIStateMotif;
  /** Seconds between discrete pulses, for rhythmic behaviour. */
  pulseSeconds: number;
  /**
   * How far a shader's domain warp pushes the field, 0–1. Low values read as a
   * calm surface; high values churn without the silhouette growing.
   */
  turbulence: number;
  /** Revolutions per second of the noise field — the slow tumble. */
  tumble: number;
  /** How much external amplitude reaches the surface, 0 = ignore it. */
  reactivity: number;
  /** Chroma multiplier. Below 1 desaturates. */
  saturation: number;
  /** Resting scale of the surface, 1 = no change. */
  scale: number;
  /** Ambient loop speed multiplier, 1 = the component's base tempo. */
  speed: number;
};

/**
 * Per-state presets.
 *
 * Deliberate choices worth keeping:
 * - `thinking` has `scale: 1` — internal churn only, so layout stays calm while
 *   the model works. Growing the surface here makes pages feel unstable.
 * - `error` desaturates instead of growing, so it reads as a state change
 *   rather than an attention grab.
 * - `done` overshoots once; components are expected to settle back to `idle`.
 * - Each state owns a distinct `motif`, so the six states are told apart by
 *   what moves, not by how fast it moves.
 */
export const AI_STATE_MOTION: Record<AIState, AIStateMotion> = {
  done: {
    accent: "success",
    glow: 0.7,
    hueRotate: 0,
    intensity: 0.4,
    motif: "ping",
    pulseSeconds: 0.65,
    reactivity: 0,
    saturation: 1,
    scale: 1.1,
    speed: 0.8,
    // The field settles almost flat — stillness is what reads as "finished".
    tumble: 0.02,
    turbulence: 0.08,
  },
  error: {
    accent: "danger",
    glow: 0.25,
    hueRotate: 0,
    intensity: 0.5,
    motif: "fault",
    pulseSeconds: 0.9,
    reactivity: 0,
    saturation: 0.3,
    scale: 0.96,
    speed: 1,
    // Tumble stalls while turbulence stays mid: the surface twitches in place
    // instead of flowing, which is what a fault feels like.
    tumble: 0,
    turbulence: 0.55,
  },
  idle: {
    accent: null,
    glow: 0.15,
    hueRotate: 0,
    intensity: 0.3,
    motif: "breathe",
    pulseSeconds: 4.5,
    reactivity: 0,
    saturation: 0.75,
    scale: 0.94,
    speed: 0.6,
    tumble: 0.012,
    turbulence: 0.14,
  },
  listening: {
    accent: null,
    glow: 0.6,
    hueRotate: 0,
    intensity: 0.75,
    motif: "receive",
    pulseSeconds: 1.6,
    reactivity: 1,
    saturation: 1.05,
    scale: 1.06,
    speed: 1,
    tumble: 0.03,
    turbulence: 0.42,
  },
  streaming: {
    accent: null,
    glow: 0.45,
    hueRotate: -10,
    intensity: 0.6,
    motif: "pulse",
    pulseSeconds: 1.25,
    reactivity: 0.6,
    saturation: 1,
    scale: 1.02,
    speed: 1.4,
    tumble: 0.06,
    turbulence: 0.5,
  },
  thinking: {
    accent: null,
    glow: 0.35,
    hueRotate: 18,
    intensity: 1,
    motif: "scan",
    pulseSeconds: 1.1,
    reactivity: 0.15,
    saturation: 1,
    scale: 1,
    speed: 2.4,
    // High churn, unchanged silhouette: the work is visible without the orb
    // growing and unsettling the layout around it.
    tumble: 0.14,
    turbulence: 0.95,
  },
};

/** Semantic accents. Deliberately not tokens — orbs render outside a theme. */
export const AI_ACCENT_COLORS: Record<"success" | "danger", string> = {
  danger: "oklch(63% 0.21 25)",
  success: "oklch(72% 0.17 150)",
};

/**
 * Colour used by a state's overlay motif: the semantic accent when the state
 * has one, otherwise the component's own secondary colour.
 */
export const getAIStateAccentColor = (
  state: AIState | undefined,
  fallback: string,
): string => {
  const accent = AI_STATE_MOTION[state ?? "idle"]?.accent;
  return accent ? AI_ACCENT_COLORS[accent] : fallback;
};

/** Motion preset for a state, falling back to `idle` for unknown values. */
export const getAIStateMotion = (state: AIState | undefined): AIStateMotion =>
  AI_STATE_MOTION[state ?? "idle"] ?? AI_STATE_MOTION.idle;

/**
 * Amplitude accepted by every reactive AI component.
 *
 * A `MotionValue` is the preferred form: it updates outside React, so a 60fps
 * audio signal never triggers a re-render.
 */
export type AIAmplitude = number | MotionValue<number> | undefined;

const isMotionValue = (value: AIAmplitude): value is MotionValue<number> =>
  typeof value === "object" && value !== null && "get" in value;

/**
 * Normalises the `amplitude` prop into a stable `MotionValue<number>` so
 * component internals only deal with one shape.
 */
export const useAmplitudeValue = (
  amplitude: AIAmplitude,
): MotionValue<number> => {
  const fallback = useMotionValue(0);
  const numeric = typeof amplitude === "number" ? amplitude : null;

  useEffect(() => {
    if (numeric !== null) {
      fallback.set(numeric);
    }
  }, [numeric, fallback]);

  return isMotionValue(amplitude) ? amplitude : fallback;
};

export type AudioAmplitudeStatus =
  | "idle"
  | "requesting"
  | "active"
  | "denied"
  | "unsupported";

export type UseAudioAmplitudeOptions = {
  /** Request microphone access as soon as the hook mounts. */
  autoStart?: boolean;
  /**
   * Envelope smoothing, 0–1. Higher is smoother and lazier; the default keeps
   * attack snappy so an orb reacts on the first syllable.
   */
  smoothing?: number;
  /** FFT size handed to the analyser node. Must be a power of two. */
  fftSize?: number;
};

export type UseAudioAmplitudeResult = {
  /** Smoothed RMS level, 0–1, as a `MotionValue`. */
  amplitude: MotionValue<number>;
  status: AudioAmplitudeStatus;
  start: () => Promise<void>;
  stop: () => void;
};

const DEFAULT_SMOOTHING = 0.55;
const DEFAULT_FFT_SIZE = 512;
/** Raw RMS rarely exceeds ~0.3 for speech, so normalise into a usable 0–1. */
const RMS_TO_UNIT = 3.2;
/** Attack is faster than release so peaks land immediately and decay gently. */
const ATTACK_FACTOR = 0.35;

/**
 * Reads microphone loudness as a 0–1 `MotionValue`.
 *
 * SSR-safe, permission-aware, and silent on failure — a denied prompt leaves
 * the amplitude at 0 so the consuming component simply falls back to its
 * ambient animation.
 */
export const useAudioAmplitude = (
  options: UseAudioAmplitudeOptions = {},
): UseAudioAmplitudeResult => {
  const {
    autoStart = false,
    smoothing = DEFAULT_SMOOTHING,
    fftSize = DEFAULT_FFT_SIZE,
  } = options;

  const amplitude = useMotionValue(0);
  const [status, setStatus] = useState<AudioAmplitudeStatus>("idle");

  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufferRef = useRef<Float32Array<ArrayBuffer> | null>(null);

  const stop = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    analyserRef.current = null;
    bufferRef.current = null;
    contextRef.current?.close();
    contextRef.current = null;
    amplitude.set(0);
    setStatus("idle");
  }, [amplitude]);

  const start = useCallback(async () => {
    if (analyserRef.current) {
      return;
    }

    const AudioContextCtor =
      typeof window === "undefined"
        ? undefined
        : (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext);

    if (!(AudioContextCtor && navigator.mediaDevices?.getUserMedia)) {
      setStatus("unsupported");
      return;
    }

    setStatus("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContextCtor();
      const analyser = context.createAnalyser();
      analyser.fftSize = fftSize;
      context.createMediaStreamSource(stream).connect(analyser);

      streamRef.current = stream;
      contextRef.current = context;
      analyserRef.current = analyser;
      bufferRef.current = new Float32Array(analyser.fftSize);
      setStatus("active");
    } catch {
      setStatus("denied");
    }
  }, [fftSize]);

  useEffect(() => {
    if (autoStart) {
      start();
    }
    return stop;
  }, [autoStart, start, stop]);

  useAnimationFrame(() => {
    const analyser = analyserRef.current;
    const buffer = bufferRef.current;
    if (!(analyser && buffer)) {
      return;
    }

    analyser.getFloatTimeDomainData(buffer);

    let sumOfSquares = 0;
    for (const sample of buffer) {
      sumOfSquares += sample * sample;
    }
    const rms = Math.sqrt(sumOfSquares / buffer.length);
    const target = Math.min(1, rms * RMS_TO_UNIT);

    const previous = amplitude.get();
    const factor = target > previous ? smoothing * ATTACK_FACTOR : smoothing;
    amplitude.set(previous + (target - previous) * (1 - factor));
  });

  return { amplitude, start, status, stop };
};

/**
 * Amplitude generator for demos, docs and previews — no microphone involved.
 *
 * Produces a plausible speech-like envelope whose energy follows the current
 * {@link AIState}, so every example can show the reactive behaviour without
 * asking the visitor for permissions.
 */
export const useSimulatedAmplitude = (
  state: AIState = "idle",
): MotionValue<number> => {
  const amplitude = useMotionValue(0);
  const motion = getAIStateMotion(state);

  useAnimationFrame((time) => {
    const t = time / 1000;
    // Three detuned sines read as organic; a single sine reads as a metronome.
    const envelope =
      0.5 +
      0.3 * Math.sin(t * 2.1 * motion.speed) +
      0.14 * Math.sin(t * 5.3 * motion.speed + 1.7) +
      0.06 * Math.sin(t * 11.7 * motion.speed + 0.4);

    amplitude.set(Math.min(1, Math.max(0, envelope * motion.intensity)));
  });

  return amplitude;
};
