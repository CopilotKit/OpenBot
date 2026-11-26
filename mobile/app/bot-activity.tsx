import { Redirect, router, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback } from "react";
import { ORGANIZATION_ID } from "../src/api";
import { stopBotHandoff } from "../src/api/generated/bots/bots";
import { cancelFollowUp } from "../src/api/generated/follow-ups/follow-ups";
import type { BotActivityItem, Task } from "../src/api/generated/model";
import { stopTask } from "../src/api/generated/tasks/tasks";
import { authClient } from "../src/auth";
import {
  type ActivityGroupId,
  canStopTask,
  groupActivity,
  itemLine,
  routineIdOf,
  taskLabel,
} from "../src/bot-activity";
import { loadBotActivity } from "../src/bot-context";
import {
  EmptyState,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
} from "../src/components";
import { IconHistory } from "../src/icons";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";
import { shortWhen } from "../src/when";

/**
 * A Bot's Activity, as the web app's: what needs you, what is working, what is lined up, what is done,
 * stopped or failed, and what recurs. A row opens its conversation, or its routine. A task that works or
 * waits on the person can be stopped, and so can work the Bot handed to another Bot; a follow-up it
 * scheduled can be cancelled.
 */
export default function BotActivityScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const action = useAction();
  const load = useCallback(() => loadBotActivity(botId), [botId]);
  const read = useLoad(load, Boolean(session && botId));
  const pull = usePull(read.refresh);
  if (!session && !isPending) return <Redirect href="/" />;
  const groups = read.data ? groupActivity(read.data) : [];

  const open = (channelId: string) =>
    router.push({
      pathname: "/conversation",
      params: { channelId, agentId: botId },
    });
  const stopButton = (
    key: string,
    stop: () => Promise<unknown>,
    [label, busy] = ["Stop", "Stopping…"],
  ) => (
    <Button
      size="sm"
      variant="secondary"
      isDisabled={Boolean(action.busy)}
      onPress={() =>
        void action.run(key, async () => {
          await stop();
          await read.refresh();
        })
      }
    >
      {action.busy === key ? busy : label}
    </Button>
  );
  const taskRow = (task: Task, group: ActivityGroupId) => (
    <Row
      key={`task:${task.id}`}
      title={task.title}
      description={[taskLabel(task, group), shortWhen(task.updatedAt)]
        .filter(Boolean)
        .join(" · ")}
      trailing={
        group !== "done" && canStopTask(task)
          ? stopButton(`task:${task.id}`, () =>
              stopTask(ORGANIZATION_ID, task.id),
            )
          : undefined
      }
      onPress={() => open(task.conversationId)}
    />
  );
  const itemRow = (item: BotActivityItem) => {
    const routineId = routineIdOf(item);
    return (
      <Row
        key={`item:${item.id}`}
        title={item.title}
        description={itemLine(item, shortWhen(item.at))}
        trailing={
          item.stoppable
            ? stopButton(`handoff:${item.id}`, () =>
                stopBotHandoff(ORGANIZATION_ID, botId, { handoffId: item.id }),
              )
            : item.cancellable
              ? stopButton(
                  `follow-up:${item.id}`,
                  () => cancelFollowUp(ORGANIZATION_ID, botId, item.id),
                  ["Cancel", "Cancelling…"],
                )
              : undefined
        }
        onPress={
          item.channelId
            ? () => open(item.channelId ?? "")
            : routineId
              ? () =>
                  router.push({ pathname: "/routine", params: { routineId } })
              : undefined
        }
      />
    );
  };

  return (
    <ScrollScreen refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Notice message={action.error || read.error} />
      {read.data && groups.length === 0 ? (
        <EmptyState
          icon={IconHistory}
          title="No activity yet"
          description="Tasks and routines show up here once this Bot starts them."
        />
      ) : null}
      {groups.map((group) => (
        <Section key={group.id} title={group.title}>
          <Rows iconless>
            {group.entries.map((entry) =>
              entry.kind === "task"
                ? taskRow(entry.task, group.id)
                : itemRow(entry.item),
            )}
          </Rows>
        </Section>
      ))}
    </ScrollScreen>
  );
}
