import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback, useMemo, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { everyPage, ME, ORGANIZATION_ID, type Routine } from "../src/api";
import {
  deleteBot,
  duplicateBot,
  getBot,
  getBotLifecycle,
  hideBot,
  pauseBot,
  pinBot,
  resetBot,
  resumeBot,
  unhideBot,
  unpinBot,
} from "../src/api/generated/bots/bots";
import { listCheckInItems } from "../src/api/generated/check-ins/check-ins";
import { listConversations } from "../src/api/generated/conversations/conversations";
import { updateBotNotificationSettings } from "../src/api/generated/notification-settings/notification-settings";
import {
  listRoutines,
  pauseRoutine,
  resumeRoutine,
} from "../src/api/generated/routines/routines";
import { authClient } from "../src/auth";
import { activitySummary, groupActivity } from "../src/bot-activity";
import {
  loadBotActivity,
  loadDestinations,
  loadPublished,
  useBotContext,
} from "../src/bot-context";
import {
  isNotifyLevel,
  manageOffer,
  mayOpenSharing,
  NOTIFY_CHOICES,
  notifyLabel,
  reachSummary,
  resetLines,
  sharingSummary,
} from "../src/bot-settings";
import { hideItem, ItemRow, startItem } from "../src/check-ins";
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
import { headerActions } from "../src/header";
import {
  IconBell,
  IconBook,
  IconBrain,
  IconChecks,
  IconClock,
  IconCopy,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconEdit,
  IconEyeOff,
  IconHistory,
  IconMessages,
  IconPin,
  IconPlayerPause,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
  IconUsersGroup,
} from "../src/icons";
import { MenuRow } from "../src/menu-row";
import { openConversationWith } from "../src/open-conversation";
import { routineLines } from "../src/routines";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";
import { dayHeading, timeOfDay } from "../src/when";

type Showing = "conversations" | "settings";

/**
 * A Bot's page: its orb and name, then its conversations by day, or its settings: whether it is
 * working for you, what it found that needs you, its routines, and what it knows and can use. A new
 * chat with it is the compose button in the header, as on Chats.
 */
export default function BotScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
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
  const loadActivity = useCallback(() => loadBotActivity(botId), [botId]);
  const activity = useLoad(loadActivity, Boolean(session && botId));
  const context = useBotContext(Boolean(session && botId));
  const loadPublication = useCallback(() => loadPublished(botId), [botId]);
  const published = useLoad(
    loadPublication,
    Boolean(session && botId) && !context.personal,
  );
  const loadReach = useCallback(() => loadDestinations(botId), [botId]);
  // Slack, Teams and text: the personal edition has none of them.
  const reach = useLoad(
    loadReach,
    Boolean(session && botId) && !context.personal,
  );
  const pull = usePull(
    bot.refresh,
    lifecycle.refresh,
    conversations.refresh,
    routines.refresh,
    items.refresh,
    activity.refresh,
    published.refresh,
    reach.refresh,
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
  const notify = lifecycle.data?.notify;
  const name = bot.data?.bot.name ?? "";
  const profile = bot.data?.bot;
  const offer = profile ? manageOffer(profile) : undefined;
  // Said only where somebody else has a Bots list of their own.
  const onlyYours = context.personal ? "" : " Only your list changes.";
  const doing = activity.data
    ? activitySummary(activity.data.activity, groupActivity(activity.data))
    : undefined;

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
  async function setNotify(level: string) {
    if (!isNotifyLevel(level) || level === notify) return;
    await action.run("notify", async () => {
      await updateBotNotificationSettings(ORGANIZATION_ID, ME, botId, {
        notify: level,
      });
      await lifecycle.refresh();
    });
  }
  /* What can be done to the Bot: pin and hide change only the person's own list. */
  const setPinned = (pinned: boolean) =>
    void action.run("pin", async () => {
      await (pinned ? pinBot : unpinBot)(ORGANIZATION_ID, botId);
      await bot.refresh();
    });
  const setHidden = (hidden: boolean) =>
    void action.run("hide", async () => {
      await (hidden ? hideBot : unhideBot)(ORGANIZATION_ID, botId);
      // A hidden Bot leaves the list it was opened from, so the page goes back to it.
      if (hidden) router.back();
      else await bot.refresh();
    });
  const duplicate = () => {
    if (action.busy) return;
    void action.run("duplicate", async () => {
      const copy = await duplicateBot(ORGANIZATION_ID, botId);
      router.replace({ pathname: "/bot", params: { botId: copy.bot.id } });
    });
  };
  // A reset first counts what it would delete, and the person sees the list before anything goes.
  const reset = () => {
    if (action.busy) return;
    void action.run("reset", async () => {
      const plan = await resetBot(ORGANIZATION_ID, botId, {
        validateOnly: true,
      });
      const lines = resetLines(plan.deleted);
      if (lines.length === 0) {
        Alert.alert(`Reset ${name}?`, "There's nothing of yours to delete.", [
          { text: "Close", style: "cancel" },
        ]);
        return;
      }
      const kept = plan.deleted.sharedConversationsKept ?? 0;
      Alert.alert(
        `Reset ${name}?`,
        [
          context.personal
            ? `This deletes what ${name} has with you. You can't undo this.`
            : `This deletes what ${name} has with you. Other people's conversations and data stay. You can't undo this.`,
          `It will delete ${lines.join(", ")}.`,
          kept > 0
            ? `${kept} ${kept === 1 ? "conversation is" : "conversations are"} shared with other people or Bots and will be kept.`
            : null,
          "Memories you told a Bot yourself are kept.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete and reset",
            style: "destructive",
            onPress: () =>
              void action.run("reset", async () => {
                await resetBot(ORGANIZATION_ID, botId, { validateOnly: false });
                await Promise.all([
                  conversations.refresh(),
                  routines.refresh(),
                  items.refresh(),
                  activity.refresh(),
                ]);
              }),
          },
        ],
      );
    });
  };
  const remove = () => {
    if (action.busy) return;
    Alert.alert(
      `Delete ${name}?`,
      context.personal
        ? "You can still read your conversations with it, but it can't reply. You can't undo this."
        : "It's deleted for everyone. You can't undo this.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            void action.run("delete", async () => {
              await deleteBot(ORGANIZATION_ID, botId);
              router.back();
            }),
        },
      ],
    );
  };
  const problem =
    action.error ||
    bot.error ||
    lifecycle.error ||
    conversations.error ||
    routines.error ||
    items.error ||
    activity.error ||
    published.error ||
    reach.error;
  const newChat = () =>
    void action.run("open", () => openConversationWith(botId));
  return (
    <Screen>
      <Stack.Screen
        options={headerActions(
          name
            ? [
                {
                  label: "New chat",
                  sf: "square.and.pencil",
                  icon: IconEdit,
                  onPress: newChat,
                },
              ]
            : [],
        )}
      />
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
            { value: "conversations", label: "Chats" },
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
                <Rows iconless>
                  {list.map((item) => (
                    <Row
                      key={item.id}
                      title={item.name}
                      description={
                        item.lastMessage ?? item.summary ?? undefined
                      }
                      trailing={
                        // Under its day's heading, only the time: "Yesterday" twice says nothing.
                        <Text variant="caption" tone="muted">
                          {timeOfDay(item.lastMessageAt ?? item.createdAt)}
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
              title="No chats yet"
              description={`Start one to give ${name || "this Bot"} some work.`}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={!name || Boolean(action.busy)}
                  onPress={newChat}
                >
                  New chat
                </Button>
              }
            />
          ) : null
        ) : (
          <>
            {found?.length ? (
              <Section title="Needs you">
                <Rows iconless>
                  {found.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      botName={name}
                      busy={action.busy}
                      className="px-3"
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
                </Rows>
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
                <MenuRow
                  icon={IconBell}
                  title="Notifications"
                  description={
                    notify === undefined
                      ? undefined
                      : [notifyLabel(notify), "Badges always show."]
                          .filter(Boolean)
                          .join(". ")
                  }
                  disabled={notify === undefined || Boolean(action.busy)}
                  groups={[
                    {
                      choices: NOTIFY_CHOICES.map((choice) => ({
                        id: choice.value,
                        title: choice.label,
                        on: choice.value === notify,
                      })),
                    },
                  ]}
                  onPick={(level) => void setNotify(level)}
                />
                <Row
                  icon={IconHistory}
                  title="Activity"
                  description={doing}
                  onPress={() =>
                    router.push({
                      pathname: "/bot-activity",
                      params: { botId },
                    })
                  }
                />
              </Rows>
            </Section>
            <Section title="Routines">
              <Rows>
                {(mine ?? []).map((routine) => (
                  <Row
                    key={routine.id}
                    icon={IconClock}
                    title={routine.title || routine.instruction}
                    {...routineLines(routine)}
                    trailing={
                      <Toggle
                        label={`${routine.title || routine.instruction} is active`}
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
                ))}
                <Row
                  icon={IconPlus}
                  title="Add routine"
                  description={
                    mine?.length === 0
                      ? "Have it do something for you on a schedule."
                      : undefined
                  }
                  onPress={() =>
                    router.push({
                      pathname: "/routine-form",
                      params: { botId },
                    })
                  }
                />
              </Rows>
            </Section>
            <Section title="Settings for this Bot">
              <Rows>
                <Row
                  icon={IconDeviceDesktop}
                  title="Computer"
                  description="Watch its screen, or take over."
                  onPress={() =>
                    router.push({ pathname: "/computer", params: { botId } })
                  }
                />
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
                <Row
                  icon={IconSettings}
                  title="Setup"
                  description="Its name, instructions and model."
                  onPress={() =>
                    router.push({ pathname: "/bot-setup", params: { botId } })
                  }
                />
                {profile &&
                mayOpenSharing(profile, {
                  ...context,
                  published: Boolean(published.data),
                }) ? (
                  <Row
                    icon={IconUsersGroup}
                    title="Sharing"
                    description={
                      published.data === undefined
                        ? undefined
                        : sharingSummary(
                            published.data ?? undefined,
                            profile.visibility,
                            context.organizationName,
                          )
                    }
                    onPress={() =>
                      router.push({
                        pathname: "/bot-sharing",
                        params: { botId },
                      })
                    }
                  />
                ) : null}
                {context.personal ? null : (
                  <Row
                    icon={IconDeviceMobile}
                    title="Reaching you"
                    description={
                      reach.data
                        ? reachSummary(
                            reach.data.map(
                              (destination) => destination.transport,
                            ),
                          )
                        : undefined
                    }
                    onPress={() =>
                      router.push({
                        pathname: "/bot-reach",
                        params: { botId },
                      })
                    }
                  />
                )}
              </Rows>
            </Section>
            {profile && offer ? (
              <Section title="Manage">
                <Rows>
                  <Row
                    icon={IconPin}
                    title="Pinned"
                    description={
                      offer.assigned
                        ? "An admin assigned it to you. It stays at the top of your Bots list."
                        : profile.pinned
                          ? `At the top of your Bots list.${onlyYours}`
                          : `Keep it at the top of your Bots list.${onlyYours}`
                    }
                    trailing={
                      <Toggle
                        label="Pinned"
                        value={profile.pinned || offer.assigned}
                        disabled={offer.assigned || Boolean(action.busy)}
                        onValueChange={setPinned}
                      />
                    }
                  />
                  <Row
                    icon={IconEyeOff}
                    title="Hidden"
                    description={
                      offer.assigned
                        ? "An admin assigned it to you. You can't hide it."
                        : profile.hidden
                          ? `Under Hidden on your Bots list.${onlyYours}`
                          : `Take it off your Bots list.${onlyYours}`
                    }
                    trailing={
                      <Toggle
                        label="Hidden"
                        value={profile.hidden}
                        disabled={offer.assigned || Boolean(action.busy)}
                        onValueChange={setHidden}
                      />
                    }
                  />
                  <Row
                    icon={IconCopy}
                    title="Duplicate"
                    description="Make your own copy. Its conversations and keys aren't copied."
                    chevron={false}
                    onPress={duplicate}
                  />
                  <Row
                    icon={IconRefresh}
                    title="Reset"
                    description="Delete your conversations with it, what it remembers for you, and its scheduled work. You'll see the list first."
                    chevron={false}
                    onPress={reset}
                  />
                  {offer.canDelete ? (
                    <Row
                      icon={IconTrash}
                      tone="danger"
                      title="Delete"
                      description={
                        context.personal
                          ? "Deletes it. You can still read your conversations with it. You can't undo this."
                          : "Deletes it for everyone. You can't undo this."
                      }
                      chevron={false}
                      onPress={remove}
                    />
                  ) : null}
                </Rows>
              </Section>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
