import type { BottomTabBarProps } from "expo-router/js-tabs";
import { Pressable, View } from "react-native";
import { cn, Icon, Text } from "./components";
import type { TablerIcon } from "./icons";

/** What a tab of the dock shows, set on its `Tabs.Screen` in app/(tabs)/_layout.tsx. */
export type DockTab = { icon: TablerIcon; label: string; badge?: number };

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
  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-border bg-background px-1 pt-1.5"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
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
            className="flex-1 items-center gap-1 py-0.5"
          >
            <View
              className={cn(
                "h-8 w-14 items-center justify-center rounded-full",
                focused && "bg-sidebar-accent",
              )}
            >
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
            <Text
              numberOfLines={1}
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
