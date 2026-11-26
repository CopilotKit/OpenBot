import { router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";
import { everyBot, ORGANIZATION_ID } from "../src/api";
import { getConversation } from "../src/api/generated/conversations/conversations";
import { authClient } from "../src/auth";
import {
  BotOrb,
  BotTile,
  Notice,
  ScrollScreen,
  Section,
  Text,
} from "../src/components";
import { useLoad } from "../src/use-load";

/**
 * A group chat's details, pushed from its header as iMessage pushes a group's: the Bots in it, side by
 * side, and a row for each that opens its page.
 */
export default function ConversationInfo() {
  const { channelId = "" } = useLocalSearchParams<{ channelId: string }>();
  const { data: session } = authClient.useSession();
  const loadConversation = useCallback(
    () => getConversation(ORGANIZATION_ID, channelId),
    [channelId],
  );
  const conversation = useLoad(loadConversation, Boolean(session));
  const loadBots = useCallback(() => everyBot(), []);
  const bots = useLoad(loadBots, Boolean(session));
  const members = (conversation.data?.conversation.botIds ?? []).map((id) => {
    const bot = bots.data?.find((item) => item.id === id);
    return {
      id,
      name: bot?.name ?? "Bot",
      seed: bot?.avatarSeed || id,
      title: bot?.title,
    };
  });
  const names = members.map((bot) => bot.name).join(", ");
  return (
    <ScrollScreen>
      <Notice message={conversation.error || bots.error} />
      <View className="items-center gap-3">
        <View className="flex-row">
          {members.slice(0, 4).map((bot, index) => (
            <View key={bot.id} className={index > 0 ? "-ml-5" : undefined}>
              <BotOrb seed={bot.seed} name={bot.name} size={64} />
            </View>
          ))}
        </View>
        <View className="items-center gap-1">
          <Text variant="heading" className="text-center">
            {conversation.data?.conversation.name || names}
          </Text>
          {members.length ? (
            <Text tone="muted" className="text-center text-sm">
              {members.length} Bots · each answers in turn
            </Text>
          ) : null}
        </View>
      </View>
      <Section title="Bots">
        <View className="overflow-hidden rounded-lg border border-border bg-surface">
          {members.map((bot) => (
            <BotTile
              key={bot.id}
              name={bot.name}
              seed={bot.seed}
              title={bot.title}
              onPress={() =>
                router.push({ pathname: "/bot", params: { botId: bot.id } })
              }
            />
          ))}
        </View>
      </Section>
    </ScrollScreen>
  );
}
