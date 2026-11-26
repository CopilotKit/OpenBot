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
import { BotOrb, cn, Text } from "./components";
import { taskLine } from "./tasks";

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

/** A link the phone may open: the web page the Bot read, never another app's scheme. */
function webLink(link: string | null) {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * One item, as a row like a chat's: the Bot that found it (its orb, when the list holds more than
 * one Bot's), what it is and why, and where it read that, then Start, Hide and, when the Bot gave a
 * link, Open. Start is the one filled button; the rest are quiet. `busy` is the action in flight on
 * this screen, so no second tap lands.
 */
export function ItemRow({
  item,
  botName,
  seed,
  busy,
  onStart,
  onHide,
  className,
}: {
  item: CheckInItem;
  botName: string;
  /** The Bot's orb seed: drawn where the list mixes Bots, left out on the Bot's own page. */
  seed?: string;
  busy: string;
  onStart: () => void;
  onHide: () => void;
  className?: string;
}) {
  const link = webLink(item.sourceLink);
  // Which Bot found it (on a list of every Bot's), and where it read that.
  const caption = [
    seed ? botName : null,
    item.sourceApp ? `From ${item.sourceApp}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View className={cn("flex-row gap-3 px-4 py-3", className)}>
      {seed ? <BotOrb seed={seed} name={botName} size={40} /> : null}
      <View className="flex-1 gap-1">
        {caption ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
        <Text variant="label">{item.title}</Text>
        {item.detail ? (
          <Text tone="muted" className="text-sm leading-5">
            {item.detail}
          </Text>
        ) : null}
        <View className="mt-2 flex-row flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={Boolean(busy)}
            onPress={onStart}
          >
            {busy === `start:${item.id}` ? "Starting…" : "Start"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
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
      </View>
    </View>
  );
}

/**
 * One task that waits on the person, as a chat's row: its Bot's orb, the Bot and where the task
 * stands, its name, and what it needs. The whole row opens its conversation, where they read and
 * reply.
 */
export function TaskRow({
  task,
  botName,
  seed,
}: {
  task: Task;
  botName: string;
  seed: string;
}) {
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
      className="flex-row gap-3 px-4 py-3 active:bg-fill"
    >
      <BotOrb seed={seed} name={botName} size={40} />
      <View className="flex-1 gap-0.5">
        <Text
          variant="caption"
          tone={task.status === "failed" ? "danger" : "warning"}
          numberOfLines={1}
        >
          {taskLine(botName, task.status)}
        </Text>
        <Text variant="label" numberOfLines={2}>
          {task.title}
        </Text>
        {next ? (
          <Text tone="muted" numberOfLines={3} className="text-sm leading-5">
            {next}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
