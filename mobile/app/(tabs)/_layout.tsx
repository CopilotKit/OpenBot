import { usePathname } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useCSSVariable } from "uniwind";
import { useNeedsYouCount } from "../../src/needs-you-count";

/**
 * The Bots tab is OpenBot's orb as a flat glyph, at SF Symbols' line weight: an outline with the orb's
 * sheen, filled when the tab is open, tinted as the other tabs' icons are.
 */
const ORB = require("../../assets/tab-orb.png");
const ORB_FILLED = require("../../assets/tab-orb-filled.png");

/**
 * The signed-in app's tabs, in the platform's own tab bar: UIKit's on iOS (iOS 26's glass, with SF
 * Symbols), Material 3's navigation bar on Android (with Material Symbols), as icons with no words
 * under them: Chats, Bots (OpenBot's orb), your account in the middle, Needs you and More. Each tab is a stack of
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
      <NativeTabs.Trigger name="(conversations)" accessibilityLabel="Chats">
        <NativeTabs.Trigger.Icon
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
          md="forum"
        />
        <NativeTabs.Trigger.Label hidden>Chats</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(bots)" accessibilityLabel="Bots">
        <NativeTabs.Trigger.Icon
          src={{ default: ORB, selected: ORB_FILLED }}
          renderingMode="template"
        />
        <NativeTabs.Trigger.Label hidden>Bots</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(account)" accessibilityLabel="Account">
        <NativeTabs.Trigger.Icon
          sf={{
            default: "person.crop.circle",
            selected: "person.crop.circle.fill",
          }}
          md="account_circle"
        />
        <NativeTabs.Trigger.Label hidden>Account</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="(needs-you)"
        // Icons only, so a screen reader is told what each tab is, and how many wait here.
        accessibilityLabel={
          waiting > 0 ? `Needs you, ${waiting} waiting` : "Needs you"
        }
      >
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
      <NativeTabs.Trigger name="(more)" accessibilityLabel="More">
        <NativeTabs.Trigger.Icon sf="ellipsis.circle" md="more_horiz" />
        <NativeTabs.Trigger.Label hidden>More</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
