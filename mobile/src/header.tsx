import { router } from "expo-router";
import type { ReactElement } from "react";
import { Platform, Pressable, useColorScheme } from "react-native";
import { useCSSVariable } from "uniwind";
import { authClient } from "./auth";
import { IconButton, PersonAvatar } from "./components";
import { IconChevronLeft } from "./icons";

/** The native header in the scheme's colors and Inter, for every stack: the app's and each tab's. */
export function useHeaderOptions() {
  const [background, foreground] = useCSSVariable([
    "--color-background",
    "--color-foreground",
  ]) as (string | undefined)[];
  const scheme = useColorScheme();
  return {
    /*
     * The header's own light or dark, for what the system draws in it: the search field, its
     * keyboard, a menu. Left alone it follows React Navigation's theme, which is always light here.
     */
    headerUserInterfaceStyle: scheme === "dark" ? "dark" : "light",
    headerBackTitle: "Back",
    headerShadowVisible: false,
    headerTintColor: foreground,
    headerStyle: { backgroundColor: background },
    headerTitleStyle: { fontFamily: "Inter_600SemiBold", color: foreground },
    headerLargeTitleStyle: { fontFamily: "Inter_700Bold", color: foreground },
    headerLargeTitleShadowVisible: false,
    contentStyle: { backgroundColor: background },
    // A pushed screen's way back, as a plain chevron.
    ...plainBackButton(),
  } as const;
}

/** A tab's own screen: a large title, and the person's account where a back button would be. */
export const tabRoot = (title: string) =>
  ({
    title,
    headerLargeTitle: true,
    ...plainHeaderLeft(() => <AccountButton />),
  }) as const;

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

/** The signed-in person's initials at the top of each tab, which open their account. */
export function AccountButton() {
  const { data: session } = authClient.useSession();
  const person = session?.user.name || session?.user.email || "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Your account"
      hitSlop={8}
      onPress={() => router.push("/account")}
      className="active:opacity-70"
    >
      <PersonAvatar name={person} size={32} />
    </Pressable>
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
