import * as Crypto from "expo-crypto";
import { router } from "expo-router";
import { Linking, Pressable, Text, View } from "react-native";
import { type CheckInItem, ORGANIZATION_ID, type Task } from "./api";
import {
  dismissCheckInItem,
  workOnCheckInItem,
} from "./api/generated/check-ins/check-ins";
import { sendConversationMessage } from "./api/generated/conversations/conversations";
import { taskLine } from "./tasks";
import { card, colors, muted } from "./ui";

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
 * One choice on a card, drawn the way this app draws something to tap: link-coloured text, as the
 * Bots list and a Bot's Customize rows are, never a system button. A system button is a filled,
 * upper-cased bar on Android and on the web, so three of them stacked on every item outweighed the
 * item itself and looked like no other screen. `primary` is the one choice the card leads with.
 */
function CardAction({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      <Text
        style={{
          color: disabled ? colors.muted : colors.link,
          fontSize: 16,
          fontWeight: primary ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
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
    <View style={card}>
      <Text style={{ fontSize: 17, fontWeight: "600" }}>{item.title}</Text>
      {item.detail ? <Text>{item.detail}</Text> : null}
      <Text style={muted}>
        {[botName, item.sourceApp ? `From ${item.sourceApp}` : null]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          columnGap: 20,
          rowGap: 8,
        }}
      >
        <CardAction
          label={busy === `start:${item.id}` ? "Starting…" : "Start"}
          disabled={Boolean(busy)}
          onPress={onStart}
          primary
        />
        <CardAction
          label={busy === `hide:${item.id}` ? "Hiding…" : "Hide"}
          disabled={Boolean(busy)}
          onPress={onHide}
        />
        {link ? (
          <CardAction
            label={`Open ${link.hostname.replace(/^www\./, "")}`}
            onPress={() => {
              void Linking.openURL(link.href);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * One task that waits on the person. The whole card opens its conversation, where they read and
 * reply, the way a row on the Bots list opens its Bot: its title in the link colour, nothing else to
 * press.
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
      style={card}
    >
      <Text style={{ fontSize: 17, fontWeight: "600", color: colors.link }}>
        {task.title}
      </Text>
      <Text
        style={{
          color: task.status === "failed" ? colors.error : colors.warning,
        }}
      >
        {taskLine(botName, task.status)}
      </Text>
      {next ? <Text numberOfLines={3}>{next}</Text> : null}
    </Pressable>
  );
}
