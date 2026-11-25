import type { ReactNode } from "react";
import { View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  interpolate,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "./cn";

/** The gap between a bar and the keyboard while the keyboard is up. */
const ABOVE_KEYBOARD = 8;

/**
 * A bar at the bottom of a screen (the message box, a list's search): clear of the home indicator
 * while the keyboard is down, and close above the keyboard while it is up, moving with it. Put it
 * inside a `KeyboardAvoidingView` (react-native-keyboard-controller), which lifts it.
 */
export function KeyboardBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const insets = useSafeAreaInsets();
  const { progress } = useReanimatedKeyboardAnimation();
  const resting = Math.max(insets.bottom, ABOVE_KEYBOARD);
  const padding = useAnimatedStyle(() => ({
    paddingBottom: interpolate(
      progress.value,
      [0, 1],
      [resting, ABOVE_KEYBOARD],
    ),
  }));
  return (
    <View className={cn("bg-background", className)}>
      <Animated.View style={padding}>{children}</Animated.View>
    </View>
  );
}
