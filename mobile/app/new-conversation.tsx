import { useCallback, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { everyBot } from "../src/api";
import { authClient } from "../src/auth";
import {
  BotOrb,
  EmptyState,
  Notice,
  Screen,
  SheetTitle,
  Text,
} from "../src/components";
import { IconRobot } from "../src/icons";
import { openConversationWith } from "../src/open-conversation";
import { useLoad } from "../src/use-load";

/** New conversation: pick the Bot to talk to. */
export default function NewConversation() {
  const { data: session } = authClient.useSession();
  const load = useCallback(() => everyBot(), []);
  const bots = useLoad(load, Boolean(session));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const listed = (bots.data ?? []).filter((bot) => !bot.hidden);
  return (
    <Screen>
      <FlatList
        className="flex-1"
        data={listed}
        keyExtractor={(bot) => bot.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="py-2"
        ListHeaderComponent={
          <View className="gap-2 px-4 pb-2">
            <SheetTitle title="New conversation" />
            <Notice message={error || bots.error} />
          </View>
        }
        renderItem={({ item: bot }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Talk to ${bot.name}`}
            disabled={Boolean(busy)}
            onPress={() => {
              setBusy(bot.id);
              setError("");
              openConversationWith(bot.id, true)
                .catch((failure: unknown) =>
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "Couldn't start the conversation. Try again.",
                  ),
                )
                .finally(() => setBusy(""));
            }}
            className="flex-row items-center gap-3 px-4 py-3 active:bg-fill"
          >
            <BotOrb
              seed={bot.avatarSeed || bot.id}
              name={bot.name}
              size={36}
              state={busy === bot.id ? "working" : "idle"}
            />
            <View className="flex-1">
              <Text variant="label">{bot.name}</Text>
              {bot.title ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {bot.title}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          bots.data ? (
            <EmptyState
              icon={IconRobot}
              title="No Bots yet"
              description="Create a Bot in OpenBot on your computer, then talk to it here."
            />
          ) : undefined
        }
      />
    </Screen>
  );
}
