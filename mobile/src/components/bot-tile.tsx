import { Pressable, View } from "react-native";
import { BotOrb } from "./bot-orb";
import { Text } from "./text";

/** A Bot in the grid of Bots: its orb, its name, and what it does under it. */
export function BotTile({
  name,
  seed,
  title,
  working,
  onPress,
}: {
  name: string;
  seed: string;
  title?: string;
  working?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}`}
      onPress={onPress}
      className="flex-1 flex-row items-center gap-3 rounded-lg px-2 py-3 active:bg-fill"
    >
      <BotOrb
        seed={seed}
        name={name}
        size={40}
        state={working ? "working" : "idle"}
      />
      <View className="flex-1">
        <Text variant="label" numberOfLines={1} className="text-sm">
          {name}
        </Text>
        {title ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {title}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
