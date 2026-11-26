import {
  type ComponentRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import type { View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BotOrb } from "./components";

/** A native view, as a ref holds it. */
export type ViewHandle = ComponentRef<typeof View>;

/** Where something is on the screen, as `measureInWindow` says it. */
export type Box = { x: number; y: number; width: number; height: number };

type Flight = { seed: string; name: string; from: Box; to: Box };

type Fly = (flight: Flight) => Promise<void>;

const FlightContext = createContext<Fly>(async () => {});

/** Where a view is on the screen, or null when it isn't laid out. */
export function measure(view: ViewHandle | null): Promise<Box | null> {
  return new Promise((resolve) => {
    if (!view) return resolve(null);
    view.measureInWindow((x, y, width, height) =>
      resolve(width > 0 && height > 0 ? { x, y, width, height } : null),
    );
  });
}

/** Sends a Bot's orb from one place on the screen to another, over everything, headers included. */
export function useOrbFlight() {
  return useContext(FlightContext);
}

/**
 * The layer a Bot's orb flies in: over the screens and their native headers, so the orb a new
 * conversation opens with can rise from the middle of the page and settle into its place in the
 * header when the first message is sent. Nothing flies when the phone asks for less motion: the
 * promise resolves at once and the orb simply appears where it lands.
 */
export function OrbFlightProvider({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const [flight, setFlight] = useState<Flight | null>(null);
  const done = useRef<(() => void) | null>(null);
  const progress = useSharedValue(0);
  const settle = useSharedValue(1);
  const land = useCallback(() => {
    done.current?.();
    done.current = null;
    setFlight(null);
  }, []);
  const fly = useCallback<Fly>(
    (next) =>
      new Promise((resolve) => {
        if (reduceMotion) return resolve();
        done.current = resolve;
        progress.value = 0;
        settle.value = 1;
        setFlight(next);
        // It floats: up and across on a long ease, then a small give as it slots into place.
        progress.value = withTiming(
          1,
          { duration: 620, easing: Easing.bezier(0.22, 1, 0.36, 1) },
          (finished) => {
            if (!finished) return runOnJS(land)();
            settle.value = withSequence(
              withTiming(1.12, { duration: 90 }),
              withSpring(1, { damping: 9, stiffness: 260 }, () =>
                runOnJS(land)(),
              ),
            );
          },
        );
      }),
    [reduceMotion, progress, settle, land],
  );
  const from = flight?.from;
  const to = flight?.to;
  const style = useAnimatedStyle(() => {
    if (!from || !to) return { opacity: 0 };
    const p = progress.value;
    const size = interpolate(p, [0, 1], [from.width, to.width]);
    const centerX = interpolate(
      p,
      [0, 1],
      [from.x + from.width / 2, to.x + to.width / 2],
    );
    // A float, not a slide: it lifts a little ahead of its path before it comes down into its place.
    const lift = Math.sin(p * Math.PI) * 18;
    const centerY =
      interpolate(p, [0, 1], [from.y + from.height / 2, to.y + to.height / 2]) -
      lift;
    return {
      opacity: 1,
      left: centerX - from.width / 2,
      top: centerY - from.height / 2,
      transform: [{ scale: (size / from.width) * settle.value }],
    };
  });
  return (
    <FlightContext.Provider value={fly}>
      {children}
      {flight && from ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              width: from.width,
              height: from.height,
            },
            style,
          ]}
        >
          <BotOrb seed={flight.seed} name={flight.name} size={from.width} />
        </Animated.View>
      ) : null}
    </FlightContext.Provider>
  );
}
