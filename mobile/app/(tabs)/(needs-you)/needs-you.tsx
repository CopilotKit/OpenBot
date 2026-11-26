import { Redirect } from "expo-router";
import { useCallback, useEffect } from "react";
import { View } from "react-native";
import { everyBot, everyPage, ORGANIZATION_ID } from "../../../src/api";
import { listCheckInItems } from "../../../src/api/generated/check-ins/check-ins";
import { listTasks } from "../../../src/api/generated/tasks/tasks";
import { authClient } from "../../../src/auth";
import { hideItem, ItemRow, startItem, TaskRow } from "../../../src/check-ins";
import {
  EmptyState,
  Notice,
  ScrollScreen,
  Text,
} from "../../../src/components";
import { IconBell } from "../../../src/icons";
import { showNeedsYouCount } from "../../../src/needs-you-count";
import { waitingTasks } from "../../../src/tasks";
import { useAction } from "../../../src/use-action";
import { useLoad } from "../../../src/use-load";

/**
 * Needs you: what every Bot's check-ins found that the person hasn't started or hidden, and the
 * tasks started from them that wait on the person. A ping's notification opens here, since one ping
 * folds several Bots' items. Each row is a chat's: its Bot's orb and name, then what it is.
 */
export default function NeedsYouScreen() {
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const loadItems = useCallback(
    () =>
      everyPage(
        (page) => listCheckInItems(ORGANIZATION_ID, page),
        (page) => page.checkInItems,
      ),
    [],
  );
  const items = useLoad(loadItems, Boolean(session));
  const loadTasks = useCallback(async () => {
    // Every page: the count of what waits on the person is of all of them.
    return {
      tasks: await everyPage(
        (page) => listTasks(ORGANIZATION_ID, page),
        (page) => page.tasks,
      ),
    };
  }, []);
  const tasks = useLoad(loadTasks, Boolean(session));
  const loadBots = useCallback(() => everyBot(), []);
  const bots = useLoad(loadBots, Boolean(session));
  const waiting = waitingTasks(tasks.data?.tasks ?? []);
  const found = items.data ?? [];
  // The tab's badge follows what this list shows, once both halves of it have been read.
  const count =
    items.data && tasks.data ? found.length + waiting.length : undefined;
  useEffect(() => {
    if (count !== undefined) showNeedsYouCount(count);
  }, [count]);
  if (!session && !isPending) return <Redirect href="/" />;
  const botOf = (agentId: string) => {
    const bot = bots.data?.find((item) => item.id === agentId);
    return { name: bot?.name ?? "A Bot", seed: bot?.avatarSeed || agentId };
  };

  const problem =
    action.error || items.error || tasks.error || bots.error || undefined;
  return (
    // Rows run the width of the screen, as the Chats and Bots lists do.
    <ScrollScreen
      className="gap-2 px-0 pt-2"
      refreshing={items.pending || tasks.pending}
      onRefresh={() => {
        void items.refresh();
        void tasks.refresh();
      }}
    >
      {problem ? (
        <View className="px-4">
          <Notice message={problem} />
        </View>
      ) : null}
      {found.length > 0 ? (
        <View>
          {found.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              botName={botOf(item.botId).name}
              seed={botOf(item.botId).seed}
              busy={action.busy}
              onStart={() => {
                void action.run(`start:${item.id}`, async () => {
                  await startItem(item);
                  void items.refresh();
                  void tasks.refresh();
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
        </View>
      ) : null}
      {items.data && found.length === 0 && waiting.length === 0 ? (
        <EmptyState
          icon={IconBell}
          title="Nothing needs you"
          description="When a Bot's check-in finds something for you, it shows up here."
        />
      ) : null}
      {waiting.length > 0 ? (
        <View className={found.length > 0 ? "pt-4" : undefined}>
          <Text
            variant="caption"
            tone="muted"
            accessibilityRole="header"
            className="px-5 pb-1 font-medium"
          >
            Tasks
          </Text>
          {waiting.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              botName={botOf(task.botId).name}
              seed={botOf(task.botId).seed}
            />
          ))}
        </View>
      ) : null}
    </ScrollScreen>
  );
}
