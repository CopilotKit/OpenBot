import { router } from "expo-router";
import type { ReactElement } from "react";
import { Platform } from "react-native";
import { IconButton } from "./components";
import { useDrawer } from "./drawer";
import { IconChevronLeft, IconMenu2 } from "./icons";

/**
 * Header buttons drawn as plain icons, as the web app's header draws them. On iOS 26 a custom
 * header item sits in a shared glass bubble by default, which on OpenBot's flat background reads
 * as a gray disc; `hidesSharedBackground` takes it away. `headerLeft` and `headerRight` draw the
 * same buttons where those items aren't read (Android).
 */
export function plainHeaderLeft(render: () => ReactElement) {
  return {
    headerLeft: render,
    unstable_headerLeftItems: () => [
      {
        type: "custom" as const,
        element: render(),
        hidesSharedBackground: true,
      },
    ],
  } as const;
}

/** {@link plainHeaderLeft}, on the header's right. */
export function plainHeaderRight(render: () => ReactElement) {
  return {
    headerRight: render,
    unstable_headerRightItems: () => [
      {
        type: "custom" as const,
        element: render(),
        hidesSharedBackground: true,
      },
    ],
  } as const;
}

/** The header's menu button on a section's screen, which opens the app's menu. */
export function MenuButton() {
  const { setOpen } = useDrawer();
  return (
    <IconButton
      icon={IconMenu2}
      label="Open menu"
      onPress={() => setOpen(true)}
    />
  );
}

/**
 * The way back on a pushed screen. On iOS 26 the system's back button sits in a glass bubble that
 * can't be taken away, so iOS gets this plain chevron in its place, as the web app's header has no
 * bubbles; swiping back from the edge works as before. Android keeps its own back arrow.
 */
export function plainBackButton() {
  if (Platform.OS !== "ios") return {};
  return {
    headerBackVisible: false,
    ...plainHeaderLeft(() => (
      <IconButton
        icon={IconChevronLeft}
        label="Back"
        onPress={() => router.back()}
      />
    )),
  } as const;
}

/** A sheet's header: no way back in it, since a sheet is put away by swiping it down. */
export const NO_HEADER_LEFT = {
  headerLeft: () => null,
  unstable_headerLeftItems: () => [],
} as const;
