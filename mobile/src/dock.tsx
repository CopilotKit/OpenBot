import type { BottomTabBarProps } from "expo-router/js-tabs";
import { Platform, Pressable, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { cn, Icon, Text } from "./components";
import type { TablerIcon } from "./icons";

/** What a tab of the dock shows, set on its `Tabs.Screen` in app/(tabs)/_layout.tsx. */
export type DockTab = { icon: TablerIcon; label: string; badge?: number };

/** How much of iOS's 34pt home indicator strip the dock's labels may sit over. */
const HOME_INDICATOR_OVERLAP = 14;

/**
 * How far the labels sit above the screen's bottom edge. On iOS the dock reaches into the home
 * indicator's strip, as the system's tab bar does, keeping clear of the indicator itself; the full
 * strip under the labels read as a gap. Android keeps its whole inset, which is the navigation
 * bar's: three buttons or the gesture handle.
 */
function bottomPadding(inset: number) {
  return Platform.OS === "ios"
    ? Math.max(inset - HOME_INDICATOR_OVERLAP, 8)
    : Math.max(inset, 8);
}

/**
 * The dock: the app's tabs along the bottom, drawn flat as the web app's sidebar is, with the
 * sidebar's soft highlight behind the tab that is open. A conversation, a Bot and the other
 * screens pushed over the tabs cover it, so the message box has the bottom to itself.
 *
 * Pressing the open tab again goes back to its first screen, as the platform's tab bar does.
 */
export function Dock({
  state,
  emitter,
  navigateToTab,
  insets,
  tabs,
}: BottomTabBarProps & { tabs: Record<string, DockTab> }) {
  // On Android the window makes room for the keyboard, which would lift the dock onto it; it steps aside instead.
  const keyboardUp = useKeyboardState((state) => state.isVisible);
  if (Platform.OS === "android" && keyboardUp) return null;
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-border bg-background px-1 pt-1.5"
      style={{ paddingBottom: bottomPadding(insets.bottom) }}
    >
      {state.routes.map((route, index) => {
        const tab = tabs[route.name];
        if (!tab) return null;
        const focused = index === state.index;
        const badge = tab.badge && tab.badge > 0 ? tab.badge : undefined;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={
              badge ? `${tab.label}, ${badge} waiting` : tab.label
            }
            onPress={() => {
              const event = emitter.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) navigateToTab(route.key);
            }}
            onLongPress={() =>
              emitter.emit({ type: "tabLongPress", target: route.key })
            }
            className="flex-1 items-center gap-1 py-0.5 active:opacity-60"
          >
            <View className="h-8 w-14 items-center justify-center">
              {/*
               * The highlight is a view of its own, made with its color and its round corners at once.
               * Set as the background of the view that was already there, Android sometimes drew it square.
               */}
              {focused ? (
                <View className="absolute inset-0 rounded-full bg-sidebar-accent" />
              ) : null}
              <Icon
                icon={tab.icon}
                size={22}
                color={focused ? "accent-foreground" : "accent-muted"}
              />
              {badge ? (
                <View className="absolute -top-0.5 left-8 h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1">
                  <Text className="text-[10px] leading-4 font-bold text-danger-foreground">
                    {badge > 99 ? "99+" : badge}
                  </Text>
                </View>
              ) : null}
            </View>
            {/* A long label shrinks a little to fit its fifth of a narrow phone, rather than being cut. */}
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              className={cn(
                "text-[11px] leading-4",
                focused ? "font-semibold text-foreground" : "text-muted",
              )}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
