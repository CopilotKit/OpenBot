import type { BottomTabBarProps } from "expo-router/js-tabs";
import { Tabs } from "expo-router/js-tabs";
import { useCSSVariable } from "uniwind";
import { Dock } from "../../src/dock";
import {
  IconBell,
  IconClock,
  IconDots,
  IconMessages,
  IconRobot,
} from "../../src/icons";
import { useNeedsYouCount } from "../../src/needs-you-count";

/**
 * The signed-in app's tabs, with the dock along the bottom (src/dock.tsx). Each tab is a stack of
 * its own with the native header. A conversation, a Bot and the rest of what is pushed from a tab
 * open in the app's stack over the tabs, so the dock steps aside for them.
 */
export default function TabsLayout() {
  const background = useCSSVariable("--color-background") as string | undefined;
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: background },
      }}
    >
      <Tabs.Screen name="(conversations)" />
      <Tabs.Screen name="(bots)" />
      <Tabs.Screen name="(routines)" />
      <Tabs.Screen name="(needs-you)" />
      <Tabs.Screen name="(more)" />
    </Tabs>
  );
}

function TabBar(props: BottomTabBarProps) {
  // Read again on each move between tabs, so starting or hiding something in Needs you shows here.
  const waiting = useNeedsYouCount(true, props.state.index);
  return (
    <Dock
      {...props}
      tabs={{
        "(conversations)": { icon: IconMessages, label: "Conversations" },
        "(bots)": { icon: IconRobot, label: "Bots" },
        "(routines)": { icon: IconClock, label: "Routines" },
        "(needs-you)": { icon: IconBell, label: "Needs you", badge: waiting },
        "(more)": { icon: IconDots, label: "More" },
      }}
    />
  );
}
