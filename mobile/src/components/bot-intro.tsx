import { View } from "react-native";
import { BotOrb } from "./bot-orb";
import { Text } from "./text";

/**
 * The Bot a conversation is with, at the top of it, as the web app opens a conversation: its orb,
 * its name, and what it does.
 */
export function BotIntro({
  seed,
  name,
  about,
}: {
  seed: string;
  name: string;
  about?: string;
}) {
  return (
    <View className="flex-row items-center gap-4 pt-2 pb-4">
      <BotOrb seed={seed} name={name} size={72} />
      <View className="flex-1 gap-1">
        <Text variant="title" className="font-bold" numberOfLines={2}>
          {name}
        </Text>
        {about ? <Text tone="muted">{about}</Text> : null}
      </View>
    </View>
  );
}
