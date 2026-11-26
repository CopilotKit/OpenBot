import { Button } from "heroui-native/button";
import { useCallback, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { everyBot } from "../src/api";
import { authClient } from "../src/auth";
import {
  BotOrb,
  EmptyState,
  Icon,
  Notice,
  Screen,
  SheetTitle,
  Text,
} from "../src/components";
import {
  IconChevronRight,
  IconCircle,
  IconCircleCheckFilled,
  IconRobot,
  IconUsersGroup,
} from "../src/icons";
import { openConversationWith } from "../src/open-conversation";
import { useLoad } from "../src/use-load";

/**
 * New conversation: tap a Bot to talk to it. "New group" turns the list into a choice of two or more
 * Bots, who all read what is sent and answer on one transcript, as the web app's group conversation.
 */
export default function NewConversation() {
  const { data: session } = authClient.useSession();
  const insets = useSafeAreaInsets();
  const load = useCallback(() => everyBot(), []);
  const bots = useLoad(load, Boolean(session));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [grouping, setGrouping] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const listed = (bots.data ?? []).filter((bot) => !bot.hidden);
  function start(botIds: string[]) {
    setBusy(true);
    setError("");
    openConversationWith(botIds.length === 1 ? (botIds[0] ?? "") : botIds, true)
      .catch((failure: unknown) =>
        setError(
          failure instanceof Error
            ? failure.message
            : "Couldn't start the conversation. Try again.",
        ),
      )
      .finally(() => setBusy(false));
  }
  const toggle = (id: string) =>
    setPicked((now) =>
      now.includes(id) ? now.filter((item) => item !== id) : [...now, id],
    );
  return (
    <Screen>
      <FlatList
        className="flex-1"
        data={listed}
        keyExtractor={(bot) => bot.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="pb-4"
        ListHeaderComponent={
          <View className="gap-2 pb-2">
            <View className="px-4">
              <SheetTitle title="New conversation" />
              <Notice message={error || bots.error} />
            </View>
            {listed.length > 1 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: grouping }}
                accessibilityLabel={grouping ? "Talk to one Bot" : "New group"}
                onPress={() => {
                  setGrouping((now) => !now);
                  setPicked([]);
                }}
                className="flex-row items-center gap-3 px-4 py-3 active:bg-fill"
              >
                <View className="size-9 items-center justify-center rounded-full bg-fill">
                  <Icon icon={IconUsersGroup} size={18} />
                </View>
                <View className="flex-1">
                  <Text variant="label">
                    {grouping ? "Talk to one Bot" : "New group"}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {grouping
                      ? "Pick two or more Bots, then start"
                      : "Several Bots on one conversation"}
                  </Text>
                </View>
                {grouping ? null : (
                  <Icon
                    icon={IconChevronRight}
                    size={16}
                    color="accent-muted"
                  />
                )}
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item: bot }) => {
          const chosen = picked.includes(bot.id);
          return (
            <Pressable
              accessibilityRole={grouping ? "checkbox" : "button"}
              accessibilityState={grouping ? { checked: chosen } : undefined}
              accessibilityLabel={grouping ? bot.name : `Talk to ${bot.name}`}
              disabled={busy}
              onPress={() => (grouping ? toggle(bot.id) : start([bot.id]))}
              className="flex-row items-center gap-3 px-4 py-3 active:bg-fill"
            >
              <BotOrb
                seed={bot.avatarSeed || bot.id}
                name={bot.name}
                size={36}
              />
              <View className="flex-1">
                <Text variant="label">{bot.name}</Text>
                {bot.title ? (
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {bot.title}
                  </Text>
                ) : null}
              </View>
              {grouping ? (
                <Icon
                  icon={chosen ? IconCircleCheckFilled : IconCircle}
                  size={22}
                  color={chosen ? "accent-foreground" : "accent-muted"}
                />
              ) : null}
            </Pressable>
          );
        }}
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
      {grouping ? (
        <View
          className="border-t border-border bg-background px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          <Button
            isDisabled={picked.length < 2 || busy}
            onPress={() => start(picked)}
          >
            {picked.length < 2
              ? "Pick two or more Bots"
              : `Start group with ${picked.length} Bots`}
          </Button>
        </View>
      ) : null}
    </Screen>
  );
}
