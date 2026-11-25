import { Redirect, router, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { everyPage, ORGANIZATION_ID, type Routine } from "../src/api";
import {
  getBot,
  getBotLifecycle,
  pauseBot,
  resumeBot,
} from "../src/api/generated/bots/bots";
import { listCheckInItems } from "../src/api/generated/check-ins/check-ins";
import { listConversations } from "../src/api/generated/conversations/conversations";
import {
  listRoutines,
  pauseRoutine,
  resumeRoutine,
} from "../src/api/generated/routines/routines";
import { authClient } from "../src/auth";
import { hideItem, ItemCard, startItem } from "../src/check-ins";
import {
  BotOrb,
  EmptyState,
  Notice,
  Refresh,
  Row,
  Rows,
  Screen,
  Section,
  Segmented,
  Text,
  Toggle,
} from "../src/components";
import {
  IconBook,
  IconBrain,
  IconChecks,
  IconClock,
  IconMessages,
  IconPlayerPause,
  IconPlug,
  IconPlus,
} from "../src/icons";
import { openConversationWith } from "../src/open-conversation";
import { ADD_ROUTINE_DRAFT, lastRunLine, when } from "../src/routines";
import { useAction } from "../src/ui";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";
import { dayHeading, shortWhen } from "../src/when";

type Showing = "conversations" | "settings";

/**
 * A Bot's page: its orb and name, then its conversations by day, or its settings: whether it is
 * working for you, what it found that needs you, its routines, and what it knows and can use.
 */
export default function BotScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const insets = useSafeAreaInsets();
  const { data: session, isPending } = authClient.useSession();
  const [view, setView] = useState<Showing>("conversations");
  const action = useAction();
  const loadBot = useCallback(() => getBot(ORGANIZATION_ID, botId), [botId]);
  const bot = useLoad(loadBot, Boolean(session && botId));
  const loadLifecycle = useCallback(
    () => getBotLifecycle(ORGANIZATION_ID, botId),
    [botId],
  );
  const lifecycle = useLoad(loadLifecycle, Boolean(session && botId));
  const loadConversations = useCallback(
    () => listConversations(ORGANIZATION_ID, { limit: 100 }),
    [],
  );
  const conversations = useLoad(loadConversations, Boolean(session));
  const loadRoutines = useCallback(
    () =>
      everyPage(
        (page) => listRoutines(ORGANIZATION_ID, page),
        (page) => page.routines,
      ),
    [],
  );
  const routines = useLoad(loadRoutines, Boolean(session));
  const loadItems = useCallback(
    () =>
      everyPage(
        (page) => listCheckInItems(ORGANIZATION_ID, page),
        (page) => page.checkInItems,
      ),
    [],
  );
  const items = useLoad(loadItems, Boolean(session));
  const pull = usePull(
    bot.refresh,
    lifecycle.refresh,
    conversations.refresh,
    routines.refresh,
    items.refresh,
  );
  // This Bot's conversations, newest first, under the day each last moved.
  const days = useMemo(() => {
    const withBot = (conversations.data?.conversations ?? []).filter((item) =>
      item.botIds.includes(botId),
    );
    const grouped = new Map<string, typeof withBot>();
    for (const item of withBot) {
      const day = dayHeading(item.lastMessageAt ?? item.createdAt);
      grouped.set(day, [...(grouped.get(day) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [conversations.data, botId]);
  if (!session && !isPending) return <Redirect href="/" />;
  const mine = routines.data?.filter((routine) => routine.botId === botId);
  const found = items.data?.filter((item) => item.botId === botId);
  const paused = lifecycle.data?.paused;
  const name = bot.data?.bot.name ?? "";

  async function setPaused(next: boolean) {
    await action.run("pause", async () => {
      await (next ? pauseBot : resumeBot)(ORGANIZATION_ID, botId);
      await lifecycle.refresh();
    });
  }
  async function setActive(routine: Routine, enabled: boolean) {
    await action.run(routine.id, async () => {
      await (enabled ? resumeRoutine : pauseRoutine)(
        ORGANIZATION_ID,
        routine.id,
      );
      await routines.refresh();
    });
  }
  async function addRoutine() {
    await action.run("add", async () => {
      const page = await listConversations(ORGANIZATION_ID, { limit: 100 });
      const conversation = page.conversations.find(
        (item) => item.active && item.botIds.includes(botId),
      );
      if (!conversation)
        throw new Error(
          `Start a conversation with ${name || "this Bot"} first, then add a routine from it.`,
        );
      router.push({
        pathname: "/conversation",
        params: {
          channelId: conversation.id,
          agentId: botId,
          draft: ADD_ROUTINE_DRAFT,
        },
      });
    });
  }

  const problem =
    action.error ||
    bot.error ||
    lifecycle.error ||
    conversations.error ||
    routines.error ||
    items.error;
  return (
    <Screen>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-4 pb-12"
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <Refresh refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
        }
      >
        <View className="items-center gap-3 pt-2">
          <BotOrb
            seed={bot.data?.bot.avatarSeed || botId}
            name={name || "Bot"}
            size={72}
          />
          <View className="items-center gap-0.5">
            <Text variant="title">{name || " "}</Text>
            {bot.data?.bot.title ? (
              <Text tone="muted" className="text-center">
                {bot.data.bot.title}
              </Text>
            ) : null}
          </View>
        </View>
        <Segmented
          label={`${name || "Bot"}: what to show`}
          options={[
            { value: "conversations", label: "Conversations" },
            { value: "settings", label: "Settings" },
          ]}
          value={view}
          onChange={setView}
        />
        <Notice message={problem} />
        {view === "conversations" ? (
          days.length ? (
            days.map(([day, list]) => (
              <Section key={day} title={day}>
                <Rows>
                  {list.map((item) => (
                    <Row
                      key={item.id}
                      title={item.name}
                      description={
                        item.lastMessage ?? item.summary ?? undefined
                      }
                      trailing={
                        <Text variant="caption" tone="muted">
                          {shortWhen(item.lastMessageAt ?? item.createdAt)}
                        </Text>
                      }
                      onPress={() =>
                        router.push({
                          pathname: "/conversation",
                          params: { channelId: item.id, agentId: botId },
                        })
                      }
                    />
                  ))}
                </Rows>
              </Section>
            ))
          ) : conversations.data ? (
            <EmptyState
              icon={IconMessages}
              title="No conversations yet"
              description={`Start one to give ${name || "this Bot"} some work.`}
            />
          ) : null
        ) : (
          <>
            {found?.length ? (
              <Section title="Needs you">
                {found.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    botName={name}
                    busy={action.busy}
                    onStart={() => {
                      void action.run(`start:${item.id}`, async () => {
                        await startItem(item);
                        void items.refresh();
                      });
                    }}
                    onHide={() => {
                      void action.run(`hide:${item.id}`, async () => {
                        await hideItem(item);
                        await items.refresh();
                      });
                    }}
                  />
                ))}
              </Section>
            ) : null}
            <Section title="Settings for you">
              <Rows>
                <Row
                  icon={IconPlayerPause}
                  title={
                    paused === undefined
                      ? "Checking…"
                      : paused
                        ? "Paused"
                        : "Active"
                  }
                  description={
                    paused
                      ? "It does no work for you, including routines, until you resume it."
                      : "It works on its routines and follow-ups for you."
                  }
                  trailing={
                    <Toggle
                      label={`${name} is active`}
                      value={paused === false}
                      disabled={paused === undefined || Boolean(action.busy)}
                      onValueChange={(active) => void setPaused(!active)}
                    />
                  }
                />
              </Rows>
            </Section>
            <Section title="Routines">
              <Rows>
                {(mine ?? []).map((routine) => {
                  const last = routine.lastRun
                    ? lastRunLine(routine.lastRun.status)
                    : null;
                  return (
                    <Row
                      key={routine.id}
                      icon={IconClock}
                      title={routine.instruction}
                      description={[
                        routine.enabled
                          ? `Next run ${when(routine.nextRunAt)}`
                          : "Paused",
                        last,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      trailing={
                        <Toggle
                          label="Active"
                          value={routine.enabled}
                          disabled={Boolean(action.busy)}
                          onValueChange={(enabled) =>
                            void setActive(routine, enabled)
                          }
                        />
                      }
                      onPress={() =>
                        router.push({
                          pathname: "/routine",
                          params: { routineId: routine.id },
                        })
                      }
                    />
                  );
                })}
                <Row
                  icon={IconPlus}
                  title="Add routine"
                  description={
                    mine?.length === 0
                      ? "No routines yet. Ask it in a conversation."
                      : undefined
                  }
                  onPress={action.busy ? undefined : () => void addRoutine()}
                />
              </Rows>
            </Section>
            <Section title="Settings for this Bot">
              <Rows>
                <Row
                  icon={IconBrain}
                  title="Memory"
                  description="What it knows about you and your work."
                  onPress={() => router.push("/memory")}
                />
                <Row
                  icon={IconBook}
                  title="Skills"
                  description="What it knows how to do."
                  onPress={() => router.push("/skills")}
                />
                <Row
                  icon={IconPlug}
                  title="Apps"
                  description="The services it can reach."
                  onPress={() =>
                    router.push({ pathname: "/plugins", params: { botId } })
                  }
                />
                <Row
                  icon={IconChecks}
                  title="Approvals"
                  description="When it stops and asks you."
                  onPress={() =>
                    router.push({ pathname: "/rules", params: { botId } })
                  }
                />
              </Rows>
            </Section>
          </>
        )}
      </ScrollView>
      {view === "conversations" ? (
        <View
          className="border-t border-border bg-background px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          <Button
            isDisabled={!name || Boolean(action.busy)}
            onPress={() =>
              void action.run("open", () => openConversationWith(botId))
            }
          >
            New conversation
          </Button>
        </View>
      ) : null}
    </Screen>
  );
}
