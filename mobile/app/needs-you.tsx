import { Redirect } from "expo-router";
import { useCallback } from "react";
import { Text } from "react-native";
import { everyBot, everyPage, ORGANIZATION_ID } from "../src/api";
import { listCheckInItems } from "../src/api/generated/check-ins/check-ins";
import { listTasks } from "../src/api/generated/tasks/tasks";
import { authClient } from "../src/auth";
import {
  hideItem,
  ItemCard,
  startItem,
  TaskCard,
  waitingTasks,
} from "../src/check-ins";
import { heading, muted, Problem, Screen, Section, useAction } from "../src/ui";
import { useLoad } from "../src/use-load";

/**
 * Needs you: what every Bot's check-ins found that the person hasn't started or hidden, and the
 * tasks started from them that wait on the person. A ping's notification opens here, since one ping
 * folds several Bots' items. Each row names its Bot.
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
  if (!session && !isPending) return <Redirect href="/" />;
  const nameOf = (agentId: string) =>
    bots.data?.find((bot) => bot.id === agentId)?.name ?? "A Bot";
  const waiting = waitingTasks(tasks.data?.tasks ?? []);
  const found = items.data ?? [];

  return (
    <Screen
      refreshing={items.pending || tasks.pending}
      onRefresh={() => {
        void items.refresh();
        void tasks.refresh();
      }}
    >
      <Text style={heading}>Needs you</Text>
      <Problem
        message={action.error || items.error || tasks.error || bots.error}
      />
      {found.map((item) => (
        <ItemCard
          key={item.id}
          item={item}
          botName={nameOf(item.botId)}
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
      {items.data && found.length === 0 && waiting.length === 0 ? (
        <Text style={muted}>
          Nothing needs you right now. When a Bot's check-in finds something for
          you, it shows up here.
        </Text>
      ) : null}
      {waiting.length > 0 ? (
        <Section title="Tasks">
          {waiting.map((task) => (
            <TaskCard key={task.id} task={task} botName={nameOf(task.botId)} />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
