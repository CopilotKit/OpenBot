import { router, Stack } from "expo-router";
import { useCallback } from "react";
import { FlatList, View } from "react-native";
import { everyBot } from "../../../src/api";
import { authClient } from "../../../src/auth";
import {
  BotTile,
  EmptyState,
  Notice,
  Refresh,
  Screen,
} from "../../../src/components";
import { tabRoot } from "../../../src/header";
import { IconPlus, IconRobot } from "../../../src/icons";
import { useLoad } from "../../../src/use-load";
import { usePull } from "../../../src/use-pull";

/** Your Bots: every Bot this person can use, a row each, each opening its page. A new Bot is the + in the header. */
export default function Bots() {
  const { data: session } = authClient.useSession();
  const load = useCallback(() => everyBot(), []);
  const bots = useLoad(load, Boolean(session));
  const pull = usePull(bots.refresh);
  const listed = (bots.data ?? []).filter((bot) => !bot.hidden);
  return (
    <Screen>
      <Stack.Screen
        options={tabRoot("Bots", [
          {
            label: "New Bot",
            sf: "plus",
            icon: IconPlus,
            onPress: () => router.push("/new-bot"),
          },
        ])}
      />
      <FlatList
        className="flex-1"
        data={listed}
        keyExtractor={(bot) => bot.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="pt-5 pb-6"
        refreshControl={
          <Refresh refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        }
        ListHeaderComponent={
          bots.error ? (
            <View className="px-4 pb-2">
              <Notice message={bots.error} />
            </View>
          ) : undefined
        }
        renderItem={({ item: bot }) => (
          <BotTile
            name={bot.name}
            seed={bot.avatarSeed || bot.id}
            title={bot.title}
            onPress={() =>
              router.push({ pathname: "/bot", params: { botId: bot.id } })
            }
          />
        )}
        ListEmptyComponent={
          bots.data ? (
            <EmptyState
              icon={IconRobot}
              title="No Bots yet"
              description="Make your first Bot with the + button."
            />
          ) : undefined
        }
      />
    </Screen>
  );
}
