/**
 * Opening the app, from the tap on its icon to the first screen, as one movement.
 *
 * The phone zooms the icon into its own splash: OpenBot's orb on the screen's background (app.config.ts). The app
 * draws that same frame again over everything (`LaunchProvider`), hides the phone's splash under it, and keeps it
 * while the app gets ready: the fonts, the security floor, the session and the version check, the four things that
 * each drew a screen of their own before. The orb breathes while it waits, and a wait past 1.5 s says what it is
 * waiting for. Then:
 *
 * - signed out, the orb glides into its place on Welcome (`LaunchOrb`) and the words rise in after it (`LaunchReveal`);
 * - signed in, or on a screen that has no orb, the orb swells and fades and the screen shows through;
 * - when less motion is asked for, the cover fades and nothing moves.
 *
 * A floor or a version check that stops the app ends the wait too: the cover fades and the stop is what shows.
 */
import * as SplashScreen from "expo-splash-screen";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type HostInstance, Image, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useCSSVariable } from "uniwind";
import { Text } from "./components/text";
import { LAUNCH_ORB_SIZE } from "./launch-orb";

// Held until the app has drawn the same frame over it. Hidden with a short fade on iOS, so a point's difference
// between the two orbs can't be seen as a jump.
void SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ fade: true, duration: 150 });

/** OpenBot's orb: the desktop app's icon, without a ground. */
const ORB = require("../assets/orb.png");

/** What the cover waits for before it opens. */
export type LaunchWait = "fonts" | "floor" | "session" | "version";
const WAITS: readonly LaunchWait[] = ["fonts", "floor", "session", "version"];

/** How long a wait may last before the cover says what it is waiting for. */
const SLOW_MS = 1_500;
/** The longest the cover stays. Every wait has a limit of its own, so this only stops a fault keeping the app shut. */
const LONGEST_MS = 12_000;
/** How long the cover waits for Welcome's orb to be laid out, once it knows the person is signed out. */
const TARGET_WAIT_MS = 400;
/**
 * The shortest the cover stays: one breath out, so a quick start still reads as the orb breathing and then moving
 * rather than a flicker.
 */
const SHORTEST_MS = 700;
/**
 * How long the cover holds once everything has answered, before it moves. Drawing the first screen's native views
 * takes the UI thread for a moment; the glide starts after that, not during it.
 */
const SETTLE_MS = 120;

/** One breath in or out. */
const BREATH_MS = 900;
/** The glide into Welcome: a spring that settles without bouncing past. */
const GLIDE = { stiffness: 170, damping: 22, mass: 1 } as const;
/** When each word on Welcome starts rising, after the glide starts. */
const REVEAL_DELAY_MS = 180;
const REVEAL_STAGGER_MS = 60;
const REVEAL_MS = 420;
const EASE_OUT = Easing.bezier(0.2, 0.8, 0.2, 1);
const EASE_IN_OUT = Easing.bezier(0.4, 0, 0.2, 1);

/**
 * - `covering`: the cover is up and waiting.
 * - `revealing`: the cover is leaving, and the screen under it comes in.
 * - `done`: the cover is gone. Anything drawn from here on is drawn in place.
 */
export type LaunchPhase = "covering" | "revealing" | "done";
type Exit = "glide" | "fade";
type Rect = { x: number; y: number; width: number; height: number };

type Launch = {
  phase: LaunchPhase;
  exit: Exit | null;
  settle: (wait: LaunchWait, blocked: boolean) => void;
  expectOrb: (expected: boolean) => void;
  placeOrb: (rect: Rect | null) => void;
};

const LaunchContext = createContext<Launch>({
  phase: "done",
  exit: null,
  settle: () => {},
  expectOrb: () => {},
  placeOrb: () => {},
});

export function useLaunchPhase() {
  return useContext(LaunchContext).phase;
}

/**
 * Tells the cover that one of the things it waits for has answered. `blocked` says the answer stops the app (the
 * security floor or the version check), so the cover fades onto that stop rather than gliding into a screen.
 */
export function useLaunchSettled(
  wait: LaunchWait,
  settled: boolean,
  blocked = false,
) {
  const { settle } = useContext(LaunchContext);
  useEffect(() => {
    if (settled) settle(wait, blocked);
  }, [settle, wait, settled, blocked]);
}

/** Tells the cover whether the first screen has Welcome's orb to glide into: it does when the person is signed out. */
export function useLaunchExpectsOrb(expected: boolean | undefined) {
  const { expectOrb } = useContext(LaunchContext);
  useEffect(() => {
    if (expected !== undefined) expectOrb(expected);
  }, [expectOrb, expected]);
}

export function LaunchProvider({
  fontsReady,
  children,
}: {
  fontsReady: boolean;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<LaunchPhase>("covering");
  const [exit, setExit] = useState<Exit | null>(null);
  const [settled, setSettled] = useState<ReadonlyMap<LaunchWait, boolean>>(
    new Map(),
  );
  const [orbExpected, setOrbExpected] = useState<boolean | null>(null);
  const [target, setTarget] = useState<Rect | null>(null);
  const [targetLate, setTargetLate] = useState(false);
  const [overdue, setOverdue] = useState(false);
  const [shownLongEnough, setShownLongEnough] = useState(false);

  const settle = useCallback((wait: LaunchWait, blocked: boolean) => {
    setSettled((now) =>
      now.get(wait) === blocked ? now : new Map(now).set(wait, blocked),
    );
  }, []);
  const expectOrb = useCallback(
    (expected: boolean) => setOrbExpected((now) => now ?? expected),
    [],
  );
  const placeOrb = useCallback((rect: Rect | null) => setTarget(rect), []);

  useEffect(() => {
    if (fontsReady) settle("fonts", false);
  }, [fontsReady, settle]);
  useEffect(() => {
    const longest = setTimeout(() => setOverdue(true), LONGEST_MS);
    const shortest = setTimeout(() => setShownLongEnough(true), SHORTEST_MS);
    return () => {
      clearTimeout(longest);
      clearTimeout(shortest);
    };
  }, []);

  const allSettled = WAITS.every((wait) => settled.has(wait));
  const blocked = [...settled.values()].some(Boolean);
  // Signed out, the cover gives Welcome a moment to lay its orb out; a screen without one fades in instead.
  useEffect(() => {
    if (!allSettled || !orbExpected || target) return;
    const timer = setTimeout(() => setTargetLate(true), TARGET_WAIT_MS);
    return () => clearTimeout(timer);
  }, [allSettled, orbExpected, target]);

  const waitingForOrb = orbExpected === true && !target && !targetLate;
  const ready =
    overdue || (shownLongEnough && allSettled && (blocked || !waitingForOrb));
  const glides = !overdue && !blocked && orbExpected === true && !!target;
  useEffect(() => {
    if (!ready || exit !== null) return;
    const timer = setTimeout(() => {
      setExit(glides ? "glide" : "fade");
      setPhase("revealing");
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [ready, exit, glides]);

  const value = useMemo(
    () => ({ phase, exit, settle, expectOrb, placeOrb }),
    [phase, exit, settle, expectOrb, placeOrb],
  );
  return (
    <LaunchContext.Provider value={value}>
      {children}
      {phase !== "done" && (
        <LaunchCover
          exit={exit}
          target={target}
          onDone={() => setPhase("done")}
        />
      )}
    </LaunchContext.Provider>
  );
}

/** The cover: the phone's splash, drawn again, then the way out of it. */
function LaunchCover({
  exit,
  target,
  onDone,
}: {
  exit: Exit | null;
  target: Rect | null;
  onDone: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const background = useCSSVariable("--color-background") as string | undefined;
  const orbRef = useRef<HostInstance>(null);
  const start = useRef<Rect | null>(null);

  const ground = useSharedValue(1);
  const breath = useSharedValue(1);
  const glow = useSharedValue(0);
  const slow = useSharedValue(0);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const size = useSharedValue(1);
  const fade = useSharedValue(1);

  // The phone's splash goes once this frame, the same one, is on screen.
  const hidden = useRef(false);
  const onLayout = () => {
    orbRef.current?.measureInWindow((left, top, width, height) => {
      start.current = { x: left, y: top, width, height };
    });
    if (hidden.current) return;
    hidden.current = true;
    requestAnimationFrame(() => void SplashScreen.hideAsync().catch(() => {}));
  };

  // Waiting: the orb breathes, and a glow behind it breathes with it. Started as the cover is committed, not after:
  // a passive effect waits for the JavaScript thread, which is busy loading the app, and the orb sat still.
  useLayoutEffect(() => {
    if (reduceMotion || exit) return;
    const ease = Easing.inOut(Easing.sin);
    breath.value = withRepeat(
      withTiming(0.93, { duration: BREATH_MS, easing: ease }),
      -1,
      true,
    );
    glow.value = withRepeat(
      withSequence(
        withTiming(0.5, { duration: BREATH_MS, easing: ease }),
        withTiming(0.12, { duration: BREATH_MS, easing: ease }),
      ),
      -1,
    );
    const timer = setTimeout(() => {
      slow.value = withTiming(1, { duration: 300, easing: EASE_OUT });
    }, SLOW_MS);
    return () => clearTimeout(timer);
  }, [reduceMotion, exit, breath, glow, slow]);

  // Leaving.
  useEffect(() => {
    if (!exit) return;
    const finish = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(onDone)();
    };
    cancelAnimation(breath);
    cancelAnimation(glow);
    slow.value = withTiming(0, { duration: 150 });
    glow.value = withTiming(0, { duration: 250 });
    if (reduceMotion) {
      ground.value = withTiming(0, { duration: 200, easing: EASE_OUT });
      fade.value = withTiming(0, { duration: 200, easing: EASE_OUT }, finish);
      return;
    }
    if (exit === "glide" && target && start.current) {
      const from = start.current;
      breath.value = withSpring(1, GLIDE);
      ground.value = withTiming(0, { duration: 200 });
      x.value = withSpring(
        target.x + target.width / 2 - (from.x + from.width / 2),
        GLIDE,
      );
      size.value = withSpring(target.width / from.width, GLIDE);
      y.value = withSpring(
        target.y + target.height / 2 - (from.y + from.height / 2),
        GLIDE,
        finish,
      );
      return;
    }
    // Into a screen with no orb of its own: the orb swells and fades, and the ground goes after it.
    size.value = withTiming(1.35, { duration: 380, easing: EASE_IN_OUT });
    fade.value = withTiming(0, { duration: 380, easing: EASE_IN_OUT });
    ground.value = withDelay(
      60,
      withTiming(0, { duration: 320, easing: EASE_IN_OUT }, finish),
    );
  }, [
    exit,
    target,
    reduceMotion,
    onDone,
    breath,
    glow,
    slow,
    fade,
    ground,
    x,
    y,
    size,
  ]);

  const groundStyle = useAnimatedStyle(() => ({ opacity: ground.value }));
  const orbStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { scale: breath.value * size.value },
    ],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: glow.value,
    transform: [{ scale: 0.9 + glow.value * 0.3 }],
  }));
  const slowStyle = useAnimatedStyle(() => ({
    opacity: slow.value * fade.value,
    transform: [{ translateY: (1 - slow.value) * 4 }],
  }));

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents={exit ? "none" : "auto"}
      onLayout={onLayout}
      accessible
      accessibilityLabel="Opening OpenBot"
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: background },
          groundStyle,
        ]}
      />
      <View style={styles.center} pointerEvents="none">
        <Animated.View style={orbStyle}>
          <Animated.View style={[styles.glow, glowStyle]} />
          <View ref={orbRef} collapsable={false} style={styles.orb}>
            <Image source={ORB} style={styles.fill} />
          </View>
        </Animated.View>
        <Animated.View style={[styles.slow, slowStyle]}>
          <Text variant="caption" tone="muted">
            Connecting to OpenBot…
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * OpenBot's orb on Welcome, where the cover's orb lands. Hidden while the cover's orb glides in, so there is only
 * ever one on screen.
 */
export function LaunchOrb({ size }: { size: number }) {
  const { phase, exit, placeOrb } = useContext(LaunchContext);
  const ref = useRef<HostInstance>(null);
  const landing = phase !== "done" && exit !== "fade";
  useEffect(() => () => placeOrb(null), [placeOrb]);
  return (
    <View
      ref={ref}
      collapsable={false}
      accessible
      accessibilityRole="image"
      accessibilityLabel="OpenBot"
      onLayout={() => {
        if (phase === "done") return;
        ref.current?.measureInWindow((x, y, width, height) =>
          placeOrb({ x, y, width, height }),
        );
      }}
      style={{ width: size, height: size, opacity: landing ? 0 : 1 }}
    >
      <Image source={ORB} style={styles.fill} />
    </View>
  );
}

/**
 * Part of the first screen that rises in as the cover leaves, `order` steps after the one before. Drawn after the
 * app has opened, it is simply there.
 */
export function LaunchReveal({
  order,
  children,
  className,
}: {
  order: number;
  children: ReactNode;
  className?: string;
}) {
  const phase = useLaunchPhase();
  const reduceMotion = useReducedMotion();
  // Only what was drawn under the cover comes in with it.
  const underCover = useRef(phase !== "done").current;
  const shown = useSharedValue(underCover ? 0 : 1);
  useEffect(() => {
    if (!underCover || phase === "covering") return;
    shown.value = reduceMotion
      ? 1
      : withDelay(
          REVEAL_DELAY_MS + order * REVEAL_STAGGER_MS,
          withTiming(1, { duration: REVEAL_MS, easing: EASE_OUT }),
        );
  }, [underCover, phase, reduceMotion, order, shown]);
  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateY: (1 - shown.value) * 14 }],
  }));
  return (
    <Animated.View className={className} style={style}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  orb: { width: LAUNCH_ORB_SIZE, height: LAUNCH_ORB_SIZE },
  fill: { width: "100%", height: "100%" },
  /*
   * The glow: the orb's colors, fading to nothing before the edge of its square. A blurred copy of the
   * orb was blurred only inside its own square on Android, so the glow stopped at a hard square edge.
   */
  glow: {
    position: "absolute",
    left: -LAUNCH_ORB_SIZE * 0.5,
    top: -LAUNCH_ORB_SIZE * 0.5,
    width: LAUNCH_ORB_SIZE * 2,
    height: LAUNCH_ORB_SIZE * 2,
    backgroundImage:
      "radial-gradient(circle closest-side, rgba(196, 112, 222, 0.75) 0%, rgba(150, 120, 240, 0.45) 50%, rgba(96, 140, 230, 0.15) 75%, rgba(96, 140, 230, 0) 100%)",
  },
  // Below the orb, out of the way of where it was, so the orb stays exactly where the phone's splash put it.
  slow: {
    position: "absolute",
    top: "50%",
    marginTop: LAUNCH_ORB_SIZE / 2 + 28,
  },
});
