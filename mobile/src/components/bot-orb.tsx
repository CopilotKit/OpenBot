import { useEffect, useId } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  RadialGradient,
  Stop,
} from "react-native-svg";
import { ORB_SHEEN, orbPalette } from "../orb-palette";

/**
 * A Bot drawn as its orb, in the palette its seed picks (`orbPalette`, the web app's), so a Bot is
 * the same color here as in the desktop's sidebar. The sphere is the web app's still orb: a mesh
 * of the palette lit from the top left, with a hairline ring.
 *
 * A Bot that is working breathes. Nothing moves when the phone asks for less motion.
 */
export function BotOrb({
  seed,
  name,
  size = 40,
  state = "idle",
}: {
  seed: string;
  name: string;
  size?: number;
  state?: "idle" | "working";
}) {
  const colors = orbPalette(seed);
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const reduceMotion = useReducedMotion();
  const breath = useSharedValue(1);
  const working = state === "working" && !reduceMotion;
  useEffect(() => {
    if (!working) {
      cancelAnimation(breath);
      breath.value = 1;
      return;
    }
    breath.value = withRepeat(
      withTiming(0.86, { duration: 1100, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [working, breath]);
  // Scale alone: a sphere that faced in and out showed the page through it, grey on dark.
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: 0.92 + (breath.value - 0.86) * (0.08 / 0.14) }],
  }));
  return (
    <Animated.View
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
      style={[{ width: size, height: size }, working ? animated : undefined]}
    >
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient
            id={`${id}body`}
            cx="38"
            cy="34"
            r="90"
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0" stopColor={colors.c4} />
            <Stop offset="0.42" stopColor={colors.c2} />
            <Stop offset="1" stopColor={colors.c3} />
          </RadialGradient>
          <LinearGradient id={`${id}tint`} x1="1" y1="0" x2="0.2" y2="0.8">
            <Stop offset="0" stopColor={colors.c1} stopOpacity="0.95" />
            <Stop offset="0.55" stopColor={colors.c1} stopOpacity="0" />
          </LinearGradient>
          <RadialGradient
            id={`${id}sheen`}
            cx="30"
            cy="24"
            r="34"
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0" stopColor={ORB_SHEEN} stopOpacity="0.32" />
            <Stop offset="1" stopColor={ORB_SHEEN} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx="50" cy="50" r="50" fill={`url(#${id}body)`} />
        <Circle cx="50" cy="50" r="50" fill={`url(#${id}tint)`} />
        <Circle cx="50" cy="50" r="50" fill={`url(#${id}sheen)`} />
      </Svg>
      <View
        pointerEvents="none"
        className="absolute inset-0 rounded-full border border-foreground/10"
      />
    </Animated.View>
  );
}
