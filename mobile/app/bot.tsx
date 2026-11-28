import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Button, Pressable, Switch, Text, View } from "react-native";
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
  ADD_ROUTINE_DRAFT,
  lastRunLine,
  runColor,
  when,
} from "../src/routines";
import {
  card,
  colors,
  heading,
  muted,
  Problem,
  Screen,
  Section,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

/**
 * The Bot profile: what its check-ins found for the person, pause, its computer, its routines, and
 * what customizes it.
 */
export default function BotScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const loadBot = useCallback(() => getBot(ORGANIZATION_ID, botId), [botId]);
  const bot = useLoad(loadBot, Boolean(session && botId));
  const loadLifecycle = useCallback(
    () => getBotLifecycle(ORGANIZATION_ID, botId),
    [botId],
  );
  const lifecycle = useLoad(loadLifecycle, Boolean(session && botId));
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
  if (!session && !isPending) return <Redirect href="/" />;
  const mine = routines.data?.filter((routine) => routine.botId === botId);
  const found = items.data?.filter((item) => item.botId === botId);
  const paused = lifecycle.data?.paused;
  const name = bot.data?.bot.name ?? "This Bot";

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
          `Start a conversation with ${name} first, then add a routine from it.`,
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

  return (
    <Screen
      refreshing={
        bot.pending || lifecycle.pending || routines.pending || items.pending
      }
      onRefresh={() => {
        void bot.refresh();
        void lifecycle.refresh();
        void routines.refresh();
        void items.refresh();
      }}
    >
      <Text style={heading}>{name}</Text>
      {bot.data?.bot.title ? (
        <Text style={muted}>{bot.data.bot.title}</Text>
      ) : null}
      <Problem
        message={
          action.error ||
          bot.error ||
          lifecycle.error ||
          routines.error ||
          items.error
        }
      />
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
      <View style={card}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontWeight: "600" }}>
              {paused === undefined
                ? "Checking…"
                : paused
                  ? "Paused"
                  : "Active"}
            </Text>
            <Text style={muted}>
              {paused
                ? "It does no work for you, including routines, until you resume it."
                : "Pausing stops its running work for you and skips routines."}
            </Text>
          </View>
          <Switch
            accessibilityLabel={`${name} is active`}
            value={paused === false}
            disabled={paused === undefined || Boolean(action.busy)}
            onValueChange={(active) => {
              void setPaused(!active);
            }}
          />
        </View>
      </View>
      <Button
        title="Open computer"
        onPress={() =>
          router.push({ pathname: "/computer", params: { botId } })
        }
      />
      <Section title="Routines">
        {mine?.map((routine) => (
          <Pressable
            key={routine.id}
            accessibilityRole="link"
            accessibilityLabel={`Routine: ${routine.instruction}`}
            onPress={() =>
              router.push({
                pathname: "/routine",
                params: { routineId: routine.id },
              })
            }
            style={card}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <Text numberOfLines={2} style={{ fontWeight: "600" }}>
                  {routine.instruction}
                </Text>
                <Text style={muted}>
                  {routine.schedule} · {routine.timezone}
                </Text>
                <Text style={muted}>
                  {routine.enabled
                    ? `Next run ${when(routine.nextRunAt)}`
                    : "Paused"}
                </Text>
                {routine.lastRun && lastRunLine(routine.lastRun.status) ? (
                  <Text style={{ color: runColor(routine.lastRun.status) }}>
                    {lastRunLine(routine.lastRun.status)}
                  </Text>
                ) : null}
              </View>
              <Switch
                accessibilityLabel="Active"
                value={routine.enabled}
                disabled={Boolean(action.busy)}
                onValueChange={(enabled) => {
                  void setActive(routine, enabled);
                }}
              />
            </View>
          </Pressable>
        ))}
        {mine?.length === 0 && <Text style={muted}>No routines yet.</Text>}
        <Button
          title="Add routine"
          disabled={Boolean(action.busy)}
          onPress={() => {
            void addRoutine();
          }}
        />
      </Section>
      <Section title="Customize">
        {[
          {
            label: "Plugins",
            go: () => router.push({ pathname: "/plugins", params: { botId } }),
          },
          { label: "Memory", go: () => router.push("/memory") },
          {
            label: "Custom rules",
            go: () => router.push({ pathname: "/rules", params: { botId } }),
          },
        ].map((item) => (
          <Pressable
            key={item.label}
            accessibilityRole="link"
            onPress={item.go}
            style={card}
          >
            <Text style={{ color: colors.link, fontSize: 16 }}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </Section>
    </Screen>
  );
}
