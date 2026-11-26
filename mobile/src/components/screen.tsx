import type { ReactNode } from "react";
import { RefreshControl, type RefreshControlProps, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useCSSVariable, withUniwind } from "uniwind";
import { cn } from "./cn";

/** A scroll view that keeps the field being typed in above the keyboard, styled by class names. */
const AwareScrollView = withUniwind(KeyboardAwareScrollView);

/** How far above the keyboard the field being typed in sits. */
const ABOVE_KEYBOARD = 24;

/** How far above the header's edge what scrolls under it fades into the page. */
const FADE = 20;

/**
 * The top edge of a screen's content: what scrolls up toward the header fades into the page's ground
 * over a few points, rather than being cut off at a hard line by the bar.
 */
export function TopFade() {
  const background = useCSSVariable("--color-background") as string | undefined;
  if (!background) return null;
  return (
    <View
      pointerEvents="none"
      className="absolute top-0 right-0 left-0"
      style={{ height: FADE }}
    >
      <Svg width="100%" height={FADE}>
        <Defs>
          <LinearGradient id="top-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={background} stopOpacity="1" />
            <Stop offset="1" stopColor={background} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height={FADE} fill="url(#top-fade)" />
      </Svg>
    </View>
  );
}

/** A screen's ground: the scheme's `background`, under the native header the route draws. */
export function Screen({
  children,
  className,
  fade = true,
}: {
  children: ReactNode;
  className?: string;
  /** False in a sheet, which has no header for its content to fade under. */
  fade?: boolean;
}) {
  return (
    <View className={cn("flex-1 bg-background", className)}>
      {children}
      {fade ? <TopFade /> : null}
    </View>
  );
}

/**
 * A screen that scrolls, with pull to refresh when it can load again. For a short page of
 * sections, and for forms: the field being typed in scrolls above the keyboard, everything below
 * it (a form's button) can be scrolled to while the keyboard is up, and dragging the page down
 * puts the keyboard away. A long list (conversations, messages) is a `FlatList` instead
 * (docs/app-guidelines.md).
 */
export function ScrollScreen({
  children,
  refreshing,
  onRefresh,
  className,
  fade = true,
}: {
  children: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  className?: string;
  /** False in a sheet, which has no header for its content to fade under. */
  fade?: boolean;
}) {
  // Inside a View: as the screen's own first child, the scroll view leaves an iOS 26 large title blank.
  return (
    <View className="flex-1 bg-background">
      <AwareScrollView
        className="flex-1"
        contentContainerClassName={cn("gap-6 px-4 pt-5 pb-12", className)}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={ABOVE_KEYBOARD}
        refreshControl={
          onRefresh ? (
            <Refresh refreshing={Boolean(refreshing)} onRefresh={onRefresh} />
          ) : undefined
        }
      >
        {children}
      </AwareScrollView>
      {fade ? <TopFade /> : null}
    </View>
  );
}

/** Pull to refresh, its spinner in the scheme's quieter text color. */
export function Refresh({
  refreshing,
  onRefresh,
  ...passed
}: RefreshControlProps) {
  const color = useCSSVariable("--color-muted") as string | undefined;
  return (
    <RefreshControl
      // What a scroll view hands its refresh control: on Android the control wraps the scroll view, so it
      // gets the scroll view as its child and the scroll view's size as its style. Dropped, the list is lost.
      {...passed}
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={color}
      colors={color ? [color] : undefined}
    />
  );
}
