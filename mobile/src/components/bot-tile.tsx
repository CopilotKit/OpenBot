import { Pressable, View } from "react-native";
import { IconChevronRight } from "../icons";
import { BotOrb } from "./bot-orb";
import { Icon } from "./icon";
import { Text } from "./text";

/**
 * A Bot in the list of Bots: its orb, its name, and what it does under it in full, as a phone's own
 * lists are a row to a thing. Two to a row cut what a Bot does to a few words.
 */
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
      className="flex-row items-center gap-3 px-4 py-3 active:bg-fill"
    >
      <BotOrb
        seed={seed}
        name={name}
        size={44}
        state={working ? "working" : "idle"}
      />
      <View className="flex-1 gap-0.5">
        <Text variant="label" numberOfLines={1}>
          {name}
        </Text>
        {title ? (
          <Text tone="muted" numberOfLines={2} className="text-sm leading-5">
            {title}
          </Text>
        ) : null}
      </View>
      <Icon icon={IconChevronRight} size={16} color="accent-muted" />
    </Pressable>
  );
}
