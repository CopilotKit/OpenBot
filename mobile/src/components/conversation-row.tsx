import { Pressable, View } from "react-native";
import { BotOrb } from "./bot-orb";
import { cn } from "./cn";
import { Text } from "./text";

export type ConversationRowBot = { id: string; name: string; seed: string };

/**
 * A conversation in a list: the Bot it is with, as its orb, the Bots' names, the conversation's
 * name, and the last thing said in it. A conversation with something new reads in a heavier
 * weight, and no color.
 */
export function ConversationRow({
  name,
  bots,
  lastMessage,
  when,
  unread,
  working,
  onPress,
}: {
  name: string;
  bots: ConversationRowBot[];
  lastMessage?: string | null;
  when?: string;
  unread?: boolean;
  working?: boolean;
  onPress: () => void;
}) {
  const lead = bots[0];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${unread ? ", new messages" : ""}`}
      onPress={onPress}
      className="flex-row gap-3 px-4 py-3 active:bg-fill"
    >
      {bots.length > 1 ? (
        // A group: its first two Bots, overlapping, in the space one orb takes.
        <View className="size-10">
          <View className="absolute top-0 left-0">
            <BotOrb
              seed={lead?.seed ?? ""}
              name={lead?.name ?? name}
              size={28}
            />
          </View>
          <View className="absolute right-0 bottom-0 rounded-full border-2 border-background">
            <BotOrb
              seed={bots[1]?.seed ?? ""}
              name={bots[1]?.name ?? name}
              size={26}
              state={working ? "working" : "idle"}
            />
          </View>
        </View>
      ) : (
        <View className="pt-0.5">
          <BotOrb
            seed={lead?.seed ?? ""}
            name={lead?.name ?? name}
            size={40}
            state={working ? "working" : "idle"}
          />
        </View>
      )}
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text
            variant="caption"
            tone="muted"
            numberOfLines={1}
            className="flex-1"
          >
            {bots.map((bot) => bot.name).join(", ")}
          </Text>
          {when ? (
            <Text variant="caption" tone="muted">
              {when}
            </Text>
          ) : null}
        </View>
        <Text
          variant="label"
          numberOfLines={1}
          className={cn(unread && "font-semibold")}
        >
          {name}
        </Text>
        {lastMessage ? (
          <Text tone="muted" numberOfLines={2} className="text-sm leading-5">
            {lastMessage}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
