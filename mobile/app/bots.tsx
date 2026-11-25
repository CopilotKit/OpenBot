import { router } from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback } from "react";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { everyBot } from "../src/api";
import { authClient } from "../src/auth";
import {
  BotTile,
  EmptyState,
  Notice,
  Refresh,
  Screen,
} from "../src/components";
import { IconRobot } from "../src/icons";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";

/** Your Bots: every Bot this person can use, two to a row, each opening its page. */
export default function Bots() {
  const insets = useSafeAreaInsets();
  const { data: session } = authClient.useSession();
  const load = useCallback(() => everyBot(), []);
  const bots = useLoad(load, Boolean(session));
  const pull = usePull(bots.refresh);
  const listed = (bots.data ?? []).filter((bot) => !bot.hidden);
  return (
    <Screen>
      <FlatList
        className="flex-1"
        data={listed}
        keyExtractor={(bot) => bot.id}
        numColumns={2}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-2 py-2"
        columnWrapperClassName="gap-1"
        refreshControl={
          <Refresh refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        }
        ListHeaderComponent={
          bots.error ? (
            <View className="px-2 pb-2">
              <Notice message={bots.error} />
            </View>
          ) : undefined
        }
        renderItem={({ item: bot, index }) => (
          <>
            <BotTile
              name={bot.name}
              seed={bot.avatarSeed || bot.id}
              title={bot.title}
              onPress={() =>
                router.push({ pathname: "/bot", params: { botId: bot.id } })
              }
            />
            {/* The last Bot of an odd count keeps half the row, as the others do. */}
            {index === listed.length - 1 && listed.length % 2 === 1 ? (
              <View className="flex-1" />
            ) : null}
          </>
        )}
        ListEmptyComponent={
          bots.data ? (
            <EmptyState
              icon={IconRobot}
              title="No Bots yet"
              description="Make your first Bot with New Bot."
            />
          ) : undefined
        }
      />
      <View
        className="border-t border-border bg-background px-4 pt-3"
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <Button onPress={() => router.push("/new-bot")}>New Bot</Button>
      </View>
    </Screen>
  );
}
