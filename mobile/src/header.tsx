import type { SFSymbol } from "expo-symbols";
import { Platform, useColorScheme, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { IconButton, Text } from "./components";
import type { TablerIcon } from "./icons";

/**
 * The native header in the scheme's colors, for every stack: the app's and each tab's. The way back
 * is the platform's own: iOS's back button (a glass chevron on iOS 26) with its edge swipe, and
 * Android's arrow with its back gesture.
 */
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
    // Only the chevron: the screen it goes back to is the one the person just came from.
    headerBackButtonDisplayMode: "minimal",
    headerShadowVisible: false,
    headerTintColor: foreground,
    // A solid bar in the page's ground; the page fades out under it (`TopFade`) rather than being cut off.
    headerStyle: { backgroundColor: background },
    headerTitleStyle: { fontFamily: "Inter_600SemiBold", color: foreground },
    headerLargeTitleStyle: { fontFamily: "Inter_700Bold", color: foreground },
    headerLargeTitleShadowVisible: false,
    contentStyle: { backgroundColor: background },
  } as const;
}

/** A button in a header: its name for a screen reader, and its glyph on each platform. */
export type HeaderAction = {
  label: string;
  /** iOS: an SF Symbol, drawn by the system in the header's glass. */
  sf: SFSymbol;
  /** Android: the app's icon, in the toolbar. */
  icon: TablerIcon;
  onPress: () => void;
};

/**
 * Buttons at the right of a header, as each platform draws its own: on iOS, bar button items with SF
 * Symbols, which iOS 26 sets in its glass; on Android, icon buttons in the toolbar.
 */
export function headerActions(actions: HeaderAction[]) {
  if (Platform.OS === "ios")
    return {
      unstable_headerRightItems: () =>
        actions.map((action) => ({
          type: "button" as const,
          label: action.label,
          accessibilityLabel: action.label,
          icon: { type: "sfSymbol" as const, name: action.sf },
          onPress: action.onPress,
        })),
    } as const;
  return {
    headerRight: () => (
      <View className="flex-row items-center gap-1">
        {actions.map((action) => (
          <IconButton
            key={action.label}
            icon={action.icon}
            label={action.label}
            onPress={action.onPress}
          />
        ))}
      </View>
    ),
  } as const;
}

/**
 * A tab's own screen. Its title sits at the start of the bar, level with the screen's buttons at the
 * end: on iOS drawn in the bar's left slot, with no glass of its own; on Android it is Material's top
 * app bar title. The person's account is a tab of its own, so no header carries it.
 */
export function tabRoot(title: string, actions: HeaderAction[] = []) {
  if (Platform.OS === "ios")
    return {
      title,
      headerTitle: "",
      headerLeft: () => <TabHeading title={title} />,
      unstable_headerLeftItems: () => [
        {
          type: "custom" as const,
          element: <TabHeading title={title} />,
          hidesSharedBackground: true,
        },
      ],
      ...headerActions(actions),
    } as const;
  return { title, ...headerActions(actions) } as const;
}

/** A tab's title at the start of iOS's bar, at the size of a large title that fits the bar's row. */
function TabHeading({ title }: { title: string }) {
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={1}
      className="font-bold text-[28px] leading-[34px]"
    >
      {title}
    </Text>
  );
}

/** A sheet's header: no way back in it, since a sheet is put away by swiping it down. */
export const NO_HEADER_LEFT = {
  headerLeft: () => null,
  unstable_headerLeftItems: () => [],
} as const;
