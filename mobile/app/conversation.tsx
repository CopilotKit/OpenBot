import * as Crypto from "expo-crypto";
import * as Notifications from "expo-notifications";
import {
  Redirect,
  router,
  Stack,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import { Button } from "heroui-native/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, FlatList, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import {
  type ConversationMessage,
  everyBot,
  ORGANIZATION_ID,
} from "../src/api";
import {
  getConversation,
  listConversationMessages,
  markConversationRead,
  sendConversationMessage,
} from "../src/api/generated/conversations/conversations";
import { authClient } from "../src/auth";
import {
  BotIntro,
  BotOrb,
  Composer,
  cn,
  KeyboardBar,
  Message,
  MessageDay,
  MessageEvent,
  MessageWorking,
  Notice,
  Screen,
  Text,
} from "../src/components";
import { headerActions } from "../src/header";
import {
  IconAlertCircle,
  IconDeviceDesktop,
  IconSettings,
  IconTool,
} from "../src/icons";
import { conversationOf, showConversation } from "../src/on-screen";
import { useLoad } from "../src/use-load";
import { dayAndTime } from "../src/when";

/** Messages this far apart get the day and time over the later one. */
const PAUSE_MS = 30 * 60 * 1000;

type Item =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: ConversationMessage };

/**
 * A conversation: the Bot at the top, what was said, and the message box. The person's messages
 * sit on the right in a quiet bubble; a Bot's are plain text, as on the web app. A conversation
 * with several Bots names the one the next message goes to, and lets the person pick another.
 */
export default function ConversationScreen() {
  const {
    channelId,
    agentId: requestedAgentId,
    draft,
  } = useLocalSearchParams<{
    channelId: string;
    agentId?: string;
    draft?: string;
  }>();
  const { data: session, isPending } = authClient.useSession();
  const [agentId, setAgentId] = useState("");
  // A Bot page's "Add routine" arrives with its sentence started for the person to finish.
  const [text, setText] = useState(draft ?? "");
  const [error, setError] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const list = useRef<FlatList<Item>>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  const loadChannels = useCallback(
    () => getConversation(ORGANIZATION_ID, channelId ?? ""),
    [channelId, session?.user.id],
  );
  const channels = useLoad(loadChannels, Boolean(session));
  const conversation = channels.data?.conversation;
  const loadBots = useCallback(() => everyBot(), []);
  const bots = useLoad(loadBots, Boolean(session));
  // The Bot the next message goes to is always one in this conversation: opening another conversation on this screen
  // (a link, a notification) picks again rather than keep the last one's Bot.
  useEffect(() => {
    if (conversation && !conversation.botIds.includes(agentId))
      setAgentId(
        requestedAgentId && conversation.botIds.includes(requestedAgentId)
          ? requestedAgentId
          : (conversation.botIds[0] ?? ""),
      );
  }, [conversation, agentId, requestedAgentId]);
  const loadHistory = useCallback(
    () =>
      listConversationMessages(ORGANIZATION_ID, channelId ?? "", {
        botId: agentId,
        limit: 200,
      }),
    [channelId, agentId],
  );
  const history = useLoad(loadHistory, Boolean(session && agentId));
  /*
   * In front of the person: a notification about this conversation shows nothing and brings what it
   * says in at once, and what the Bot said is marked read, as the web app marks the conversation it
   * shows. Read only while the app is open on this screen, so a reply that lands with the phone
   * locked is still unread, and still told about, until they come back to it.
   */
  const [inFront, setInFront] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (!channelId) return;
      const leave = showConversation(channelId);
      setInFront(AppState.currentState === "active");
      const appState = AppState.addEventListener("change", (state) =>
        setInFront(state === "active"),
      );
      const arrived = Notifications.addNotificationReceivedListener(
        (notification) => {
          if (conversationOf(notification.request.content.data) === channelId)
            void history.refresh();
        },
      );
      return () => {
        leave();
        setInFront(false);
        appState.remove();
        arrived.remove();
      };
    }, [channelId, history.refresh]),
  );
  const newest = history.data?.messages[0]?.id;
  useEffect(() => {
    if (inFront && channelId && newest)
      void markConversationRead(ORGANIZATION_ID, channelId).catch(() => {});
  }, [inFront, channelId, newest]);
  const botsHere = (conversation?.botIds ?? []).map((id) => {
    const bot = bots.data?.find((item) => item.id === id);
    return {
      id,
      name: bot?.name ?? "Bot",
      seed: bot?.avatarSeed || id,
      // What the Bot does, as the web app's introduction says it.
      about:
        [bot?.title, bot?.roleDescription]
          .filter((part) => part?.trim())
          .join(" · ") || undefined,
    };
  });
  const current = botsHere.find((bot) => bot.id === agentId);
  const working = Boolean(conversation?.work?.length);
  const replyUnderway = (history.data?.messages ?? []).some(
    (message) => message.status === "queued" || message.status === "running",
  );
  // Newest first, as the API answers and as an inverted list draws from the bottom up.
  const items = useMemo<Item[]>(() => {
    const oldestFirst = (history.data?.messages ?? []).slice().reverse();
    const out: Item[] = [];
    let previous = 0;
    for (const message of oldestFirst) {
      const at = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
      if (!Number.isNaN(at) && (out.length === 0 || at - previous > PAUSE_MS))
        out.push({
          kind: "day",
          key: `day:${message.id}`,
          label: dayAndTime(message.createdAt),
        });
      if (!Number.isNaN(at)) previous = at;
      out.push({ kind: "message", key: message.id, message });
    }
    return out.reverse();
  }, [history.data]);
  if (!session && !isPending) return <Redirect href="/" />;

  async function send() {
    if (!text.trim() || !agentId || sending) return;
    const pendingText = text;
    setSending(pendingText);
    // What they send shows at once, wherever they had scrolled to: the newest end is offset 0.
    list.current?.scrollToOffset({ offset: 0, animated: true });
    setError("");
    setText("");
    try {
      await sendConversationMessage(ORGANIZATION_ID, channelId, {
        id: Crypto.randomUUID(),
        text: pendingText,
        botId: agentId,
      });
      await history.refresh();
    } catch (failure) {
      // What they wrote goes back in the box, so nothing is lost.
      setText(pendingText);
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't send your message. Try again.",
      );
    } finally {
      setSending(null);
    }
  }

  return (
    <Screen>
      <Stack.Screen
        options={{
          // Who the conversation is with, as iMessage heads one: their orbs, and their names under them.
          title: conversation?.name ?? current?.name ?? "",
          headerTitleAlign: "center",
          headerTitle: () =>
            botsHere.length ? (
              <ConversationHeading
                bots={botsHere}
                working={working}
                conversationName={conversation?.name}
              />
            ) : null,
          // The Bot's computer and its settings, as the platform draws a header's buttons.
          ...(agentId
            ? headerActions([
                {
                  label: `${current?.name ?? "Bot"}'s computer`,
                  sf: "desktopcomputer",
                  icon: IconDeviceDesktop,
                  onPress: () =>
                    router.push({
                      pathname: "/computer",
                      params: { botId: agentId },
                    }),
                },
                {
                  label: `${current?.name ?? "Bot"} settings`,
                  sf: "gearshape",
                  icon: IconSettings,
                  onPress: () =>
                    router.push({
                      pathname: "/bot",
                      params: { botId: agentId },
                    }),
                },
              ])
            : headerActions([])),
        }}
      />
      <KeyboardAvoidingView
        behavior="padding"
        automaticOffset
        className="flex-1"
      >
        {botsHere.length > 1 ? (
          <View className="flex-row flex-wrap gap-2 border-b border-border px-4 py-2">
            {botsHere.map((bot) => {
              const selected = bot.id === agentId;
              return (
                <Pressable
                  key={bot.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Talk to ${bot.name}`}
                  onPress={() => setAgentId(bot.id)}
                  className={cn(
                    "flex-row items-center gap-1.5 rounded-full border py-1 pr-3 pl-1",
                    selected
                      ? "border-foreground bg-fill"
                      : "border-border bg-surface",
                  )}
                >
                  <BotOrb seed={bot.seed} name={bot.name} size={20} />
                  <Text variant="caption" className="font-medium">
                    {bot.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <FlatList
          ref={list}
          className="flex-1"
          inverted
          data={items}
          keyExtractor={(item) => item.key}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          // Drawn bottom up, so a long conversation opens at its newest message; a short one is pushed to the top
          // rather than hanging at the bottom over an empty page.
          contentContainerClassName="grow justify-end gap-3 px-4 py-4"
          ListHeaderComponent={
            sending ? (
              <Message from="person" text={sending} pending />
            ) : working && current && !replyUnderway ? (
              // The Bot is at work in this conversation with no reply of its own on screen yet.
              <MessageWorking
                seed={current.seed}
                name={current.name}
                label="Working…"
              />
            ) : undefined
          }
          renderItem={({ item }) =>
            item.kind === "day" ? (
              <MessageDay label={item.label} />
            ) : (
              <MessageLine
                message={item.message}
                bot={{
                  seed: current?.seed ?? "",
                  name: current?.name ?? "Bot",
                }}
                onReview={() =>
                  router.push({ pathname: "/approvals", params: { channelId } })
                }
              />
            )
          }
          // The list is drawn bottom up, so its footer is the top of the conversation. Only an empty one says who
          // the Bot is and what it does: once there is something said, the header names who it is with.
          ListFooterComponent={
            history.data && current && items.length === 0 && !sending ? (
              <BotIntro
                seed={current.seed}
                name={current.name}
                about={current.about}
              />
            ) : undefined
          }
        />
        <KeyboardBar className="px-3 pt-1">
          <View className="gap-2">
            <Notice
              message={error || channels.error || history.error || undefined}
            />
            {conversation && !conversation.active ? (
              <Notice
                tone="info"
                message="This conversation has ended. Start a new one from the Bot's page."
              />
            ) : null}
            <Composer
              value={text}
              onChangeText={setText}
              onSend={() => void send()}
              placeholder={`Message ${current?.name ?? "this Bot"}`}
              disabled={!conversation?.active || !agentId}
              sending={Boolean(sending)}
              autoFocus={Boolean(draft)}
            />
          </View>
        </KeyboardBar>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The Bot a line of the conversation is from, for its orb while it works. */
type Speaker = { seed: string; name: string };

/**
 * One line of the conversation, by who said it. A role this app doesn't know reads as an event. A
 * Bot's reply says where it stands: still being written, waiting on the person, or stopped; a status
 * this app doesn't know reads as finished.
 */
function MessageLine({
  message,
  bot,
  onReview,
}: {
  message: ConversationMessage;
  bot: Speaker;
  /** Opens what the Bot is waiting on: the approval inbox, where its request or question is. */
  onReview: () => void;
}) {
  if (message.role === "person")
    return <Message from="person" text={message.text} />;
  if (message.role === "bot") {
    const unfinished =
      message.status === "queued" || message.status === "running";
    if (unfinished && !message.text)
      return (
        <MessageWorking
          seed={bot.seed}
          name={bot.name}
          label={message.status === "queued" ? "Starting…" : "Working…"}
        />
      );
    const said = message.text ? (
      <Message from="bot" text={message.text} />
    ) : message.toolCalls ? (
      <ToolLine count={message.toolCalls} />
    ) : null;
    if (message.status === "waiting")
      return (
        <View className="gap-2">
          {said}
          <Notice
            tone="warning"
            message={message.reason || `${bot.name} is waiting for you.`}
            action={
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onPress={onReview}
              >
                Review
              </Button>
            }
          />
        </View>
      );
    if (message.status === "failed" && !message.declined)
      return (
        <View className="gap-2">
          {said}
          <MessageEvent
            icon={IconAlertCircle}
            tone="danger"
            text="This reply stopped before it finished."
          />
        </View>
      );
    if (message.declined && message.text)
      return <MessageEvent text={message.text} />;
    return said ?? <ToolLine count={0} />;
  }
  if (message.role === "tool")
    return message.text ? (
      <MessageEvent icon={IconTool} text={message.text} />
    ) : (
      <ToolLine count={0} />
    );
  return message.text ? <MessageEvent text={message.text} /> : null;
}

/** A Bot's turn that used tools and said nothing. */
function ToolLine({ count }: { count: number }) {
  return (
    <MessageEvent
      icon={IconTool}
      text={count > 1 ? `Used ${count} tools.` : "Used a tool."}
    />
  );
}

/**
 * The header's title in a conversation, as iMessage heads one: the orb of each Bot in it, side by
 * side and overlapping when there are several, and their names under them. The lead Bot's orb
 * breathes while the conversation is at work.
 */
function ConversationHeading({
  bots,
  working,
  conversationName,
}: {
  bots: { id: string; name: string; seed: string }[];
  working: boolean;
  conversationName?: string;
}) {
  const names =
    bots.length > 2
      ? `${bots[0]?.name}, ${bots[1]?.name} and ${bots.length - 2} more`
      : bots.map((bot) => bot.name).join(" & ");
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={[conversationName, `with ${names}`]
        .filter(Boolean)
        .join(", ")}
      className="items-center gap-0.5"
    >
      <View className="flex-row">
        {bots.slice(0, 3).map((bot, index) => (
          <View key={bot.id} className={cn(index > 0 && "-ml-2")}>
            <BotOrb
              seed={bot.seed}
              name={bot.name}
              size={26}
              state={working && index === 0 ? "working" : "idle"}
            />
          </View>
        ))}
      </View>
      <Text numberOfLines={1} className="max-w-56 font-medium text-xs">
        {names}
      </Text>
    </View>
  );
}
