import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { Button } from "heroui-native/button";
import { Linking, Pressable, View } from "react-native";
import { type CheckInItem, ORGANIZATION_ID, type Task } from "./api";
import {
  dismissCheckInItem,
  workOnCheckInItem,
} from "./api/generated/check-ins/check-ins";
import { sendConversationMessage } from "./api/generated/conversations/conversations";
import { Card, Text } from "./components";
import { taskLine } from "./tasks";
import { webLink } from "./web-link";

/*
 * What a Bot's check-in found, on the phone: the Needs you list a ping opens, and the same rows on
 * the Bot's own screen. As on the web, Start hands an item to its Bot and Hide takes it off the
 * list, and the Bot is told not to raise it again.
 */

/**
 * Start an item and open the conversation the Bot works on it in. The server decides where: with
 * task threads off, the person's own conversation with the Bot, where the item is sent as their
 * message like any other request; with them on, a task's conversation of its own.
 */
export async function startItem(item: CheckInItem) {
  const work = await workOnCheckInItem(ORGANIZATION_ID, item.id);
  const channelId = work.conversation?.id ?? work.task?.conversationId;
  if (!channelId) return;
  if (work.conversation)
    await sendConversationMessage(ORGANIZATION_ID, channelId, {
      id: Crypto.randomUUID(),
      text: work.conversation.message,
      botId: item.botId,
    });
  router.push({
    pathname: "/conversation",
    params: { channelId, agentId: item.botId },
  });
}

/** Hide an item: off every list, and remembered for 30 days. */
export async function hideItem(item: CheckInItem) {
  await dismissCheckInItem(ORGANIZATION_ID, item.id);
}

/**
 * One item: what it is, why, which Bot found it and where it read that, with Start, Hide and, when
 * the Bot gave a link, Open. `busy` is the action in flight on this screen, so no second tap lands.
 */
export function ItemCard({
  item,
  botName,
  busy,
  onStart,
  onHide,
}: {
  item: CheckInItem;
  botName: string;
  busy: string;
  onStart: () => void;
  onHide: () => void;
}) {
  const link = webLink(item.sourceLink);
  return (
    <Card>
      <Text variant="label" className="font-semibold">
        {item.title}
      </Text>
      {item.detail ? <Text>{item.detail}</Text> : null}
      <Text variant="caption" tone="muted">
        {[botName, item.sourceApp ? `From ${item.sourceApp}` : null]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <View className="mt-1 flex-row flex-wrap gap-2">
        <Button size="sm" isDisabled={Boolean(busy)} onPress={onStart}>
          {busy === `start:${item.id}` ? "Starting…" : "Start"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          isDisabled={Boolean(busy)}
          onPress={onHide}
        >
          {busy === `hide:${item.id}` ? "Hiding…" : "Hide"}
        </Button>
        {link ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              void Linking.openURL(link.href);
            }}
          >
            {`Open ${link.hostname.replace(/^www\./, "")}`}
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

/**
 * One task that waits on the person. The whole card opens its conversation, where they read and
 * reply, the way a row on the Bots list opens its Bot: nothing else to press.
 */
export function TaskCard({ task, botName }: { task: Task; botName: string }) {
  const next =
    task.status === "failed"
      ? task.failure
        ? `Couldn't finish: ${task.failure}.`
        : "Couldn't finish."
      : task.next?.trim() || null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${task.title}`}
      onPress={() =>
        router.push({
          pathname: "/conversation",
          params: { channelId: task.conversationId, agentId: task.botId },
        })
      }
      className="gap-1.5 rounded-lg border border-border bg-surface p-4 active:bg-fill"
    >
      <Text variant="label" className="font-semibold">
        {task.title}
      </Text>
      <Text
        variant="caption"
        tone={task.status === "failed" ? "danger" : "warning"}
      >
        {taskLine(botName, task.status)}
      </Text>
      {next ? (
        <Text tone="muted" numberOfLines={3}>
          {next}
        </Text>
      ) : null}
    </Pressable>
  );
}
