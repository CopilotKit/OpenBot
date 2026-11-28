import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Tab } from "../logic/machine";
import { BotsIcon, ConversationsIcon, HomeIcon } from "./Icons";
import type { Colors } from "./theme";

const ITEMS: { tab: Tab; label: string; Icon: typeof HomeIcon }[] = [
  { tab: "conversations", label: "Chats", Icon: ConversationsIcon },
  { tab: "home", label: "Home", Icon: HomeIcon },
  { tab: "bots", label: "Bots", Icon: BotsIcon },
];

export const TAB_BAR_HEIGHT = 56;

/**
 * The bottom bar: Chats, Home, Bots (the bridge still calls the first tab `conversations`). Native views drawn by React Native (not UITabBar or
 * BottomNavigationView: the one web view stays put under all three tabs, which the system tab bars,
 * each hosting a screen per tab, do not allow without re-parenting the web view).
 */
export function TabBar(props: {
  colors: Colors;
  selected: Tab;
  background: string;
  bottomInset: number;
  disabled: boolean;
  onPress: (tab: Tab) => void;
}) {
  const { colors } = props;
  return (
    <View
      testID="tab-bar"
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          backgroundColor: props.background,
          borderTopColor: colors.border,
          paddingBottom: props.bottomInset,
        },
      ]}
    >
      {ITEMS.map(({ tab, label, Icon }) => {
        const selected = tab === props.selected;
        const tint = selected ? colors.foreground : colors.mutedForeground;
        return (
          <Pressable
            key={tab}
            testID={`tab-${tab}`}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onPress(tab)}
            style={styles.item}
          >
            <Icon color={tint} strokeWidth={selected ? 2.25 : 1.75} />
            <Text
              style={[
                styles.label,
                { color: tint, fontWeight: selected ? "600" : "400" },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  item: {
    flex: 1,
    height: TAB_BAR_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  label: { fontSize: 11 },
});
