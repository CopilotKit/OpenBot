import { usePathname } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useCSSVariable } from "uniwind";
import { useNeedsYouCount } from "../../src/needs-you-count";

/** The Bots tab is OpenBot's orb, drawn in one color as the other tabs' icons are: its shading is in its alpha. */
const ORB = require("../../assets/tab-orb.png");

/**
 * The signed-in app's tabs, in the platform's own tab bar: UIKit's on iOS (iOS 26's glass, with SF
 * Symbols), Material 3's navigation bar on Android (with Material Symbols), as icons with no words
 * under them: Conversations, Bots (OpenBot's orb), your account in the middle, Needs you and More. Each tab is a stack of
 * its own with the native header. A conversation, a Bot and the rest of what is pushed from a tab
 * open in the app's stack over the tabs, so the tab bar steps aside for them.
 */
export default function TabsLayout() {
  // Read again on each move between tabs, so starting or hiding something in Needs you shows here.
  const waiting = useNeedsYouCount(true, usePathname());
  const [foreground, muted, background, highlight, danger] = useCSSVariable([
    "--color-foreground",
    "--color-muted",
    "--color-background",
    "--color-sidebar-accent",
    "--color-danger",
  ]) as (string | undefined)[];
  return (
    <NativeTabs
      // The open tab in the text color, the rest in the quieter one: the scheme has no brand blue.
      tintColor={foreground}
      iconColor={{ default: muted, selected: foreground }}
      // Android's bar on the screen's ground, with the sidebar's soft highlight behind the open tab.
      backgroundColor={background}
      indicatorColor={highlight}
      badgeBackgroundColor={danger}
      labelVisibilityMode="unlabeled"
    >
      <NativeTabs.Trigger name="(conversations)">
        <NativeTabs.Trigger.Icon
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
          md="forum"
        />
        <NativeTabs.Trigger.Label hidden>
          Conversations
        </NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(bots)">
        <NativeTabs.Trigger.Icon src={ORB} renderingMode="template" />
        <NativeTabs.Trigger.Label hidden>Bots</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(account)">
        <NativeTabs.Trigger.Icon
          sf={{
            default: "person.crop.circle",
            selected: "person.crop.circle.fill",
          }}
          md="account_circle"
        />
        <NativeTabs.Trigger.Label hidden>Account</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(needs-you)">
        <NativeTabs.Trigger.Icon
          sf={{ default: "bell", selected: "bell.fill" }}
          md="notifications"
        />
        <NativeTabs.Trigger.Label hidden>Needs you</NativeTabs.Trigger.Label>
        {waiting > 0 ? (
          <NativeTabs.Trigger.Badge>
            {waiting > 99 ? "99+" : String(waiting)}
          </NativeTabs.Trigger.Badge>
        ) : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(more)">
        <NativeTabs.Trigger.Icon sf="ellipsis.circle" md="more_horiz" />
        <NativeTabs.Trigger.Label hidden>More</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
