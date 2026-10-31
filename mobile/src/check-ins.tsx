import { router } from "expo-router";
import { Button, Linking, Text, View } from "react-native";
import {
  api,
  type BotTask,
  type CheckInItem,
  type StartedItem,
  type TaskStatus,
} from "./api";
import { card, colors, muted } from "./ui";

/*
 * What a Bot's check-in found, on the phone: the Needs you list a ping opens, and the same rows on
 * the Bot's own screen. As on the web, Start makes an item a task in a conversation of its own and
 * Hide takes it off the list, and the Bot is told not to raise it again.
 */

/** Start an item and open the conversation its task runs in. */
export async function startItem(item: CheckInItem) {
  const started = await api<StartedItem>(
    `/api/proactive/suggestions/${encodeURIComponent(item.id)}/start`,
    { method: "POST" },
  );
  router.push({
    pathname: "/conversation",
    params: { channelId: started.task.channelId, agentId: item.agentId },
  });
}

/** Hide an item: off every list, and remembered for 30 days. */
export async function hideItem(item: CheckInItem) {
  await api(
    `/api/proactive/suggestions/${encodeURIComponent(item.id)}/dismiss`,
    {
      method: "POST",
    },
  );
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
      <Text style={{ fontWeight: "600", fontSize: 16 }}>{item.title}</Text>
      {item.detail ? <Text>{item.detail}</Text> : null}
      <Text style={muted}>
        {[botName, item.sourceApp ? `From ${item.sourceApp}` : null]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          title={busy === `start:${item.id}` ? "Starting…" : "Start"}
          disabled={Boolean(busy)}
          onPress={onStart}
        />
        <Button
          title={busy === `hide:${item.id}` ? "Hiding…" : "Hide"}
          disabled={Boolean(busy)}
          onPress={onHide}
        />
        {link ? (
          <Button
            title={`Open ${link.hostname.replace(/^www\./, "")}`}
            onPress={() => {
              void Linking.openURL(link.href);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

const TASK_LABEL: Record<TaskStatus, string> = {
  ready_for_review: "Ready for review",
  needs_input: "Needs input",
  failed: "Failed",
  working: "Working",
  resolved: "Resolved",
};

/** Top to bottom, as on the web: what to read, what to answer, what to retry. */
const WAITS_ON_YOU: readonly TaskStatus[] = [
  "ready_for_review",
  "needs_input",
  "failed",
];

/** The tasks that wait on the person, in the order they are listed, newest first within each. */
export function waitingTasks(tasks: readonly BotTask[]): BotTask[] {
  return tasks
    .filter((task) => WAITS_ON_YOU.includes(task.status))
    .sort(
      (a, b) =>
        WAITS_ON_YOU.indexOf(a.status) - WAITS_ON_YOU.indexOf(b.status) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
}

/** One task that waits on the person. A tap opens its conversation, where they read and reply. */
export function TaskCard({
  task,
  botName,
}: {
  task: BotTask;
  botName: string;
}) {
  const next =
    task.status === "failed"
      ? task.failure
        ? `Couldn't finish: ${task.failure}.`
        : "Couldn't finish."
      : task.next?.trim() || null;
  return (
    <View style={card}>
      <Text style={{ fontWeight: "600", fontSize: 16 }}>{task.title}</Text>
      <Text
        style={{
          color: task.status === "failed" ? colors.error : colors.warning,
        }}
      >
        {botName} · {TASK_LABEL[task.status]}
      </Text>
      {next ? <Text numberOfLines={3}>{next}</Text> : null}
      <Button
        title="Open"
        onPress={() =>
          router.push({
            pathname: "/conversation",
            params: { channelId: task.channelId, agentId: task.agentId },
          })
        }
      />
    </View>
  );
}
