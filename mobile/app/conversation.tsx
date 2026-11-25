import * as Crypto from "expo-crypto";
import * as Notifications from "expo-notifications";
import {
  Redirect,
  router,
  Stack,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, FlatList, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  BotOrb,
  Composer,
  cn,
  EmptyState,
  IconButton,
  Message,
  MessageDay,
  MessageEvent,
  Notice,
  Screen,
  Text,
} from "../src/components";
import { IconSettings, IconTool } from "../src/icons";
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
  const insets = useSafeAreaInsets();
  const { data: session, isPending } = authClient.useSession();
  const [agentId, setAgentId] = useState("");
  // A Bot page's "Add routine" arrives with its sentence started for the person to finish.
  const [text, setText] = useState(draft ?? "");
  const [error, setError] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  const loadChannels = useCallback(
    () => getConversation(ORGANIZATION_ID, channelId ?? ""),
    [channelId, session?.user.id],
  );
  const channels = useLoad(loadChannels, Boolean(session));
  const conversation = channels.data?.conversation;
  const loadBots = useCallback(() => everyBot(), []);
  const bots = useLoad(loadBots, Boolean(session));
  useEffect(() => {
    if (conversation && !agentId)
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
    return { id, name: bot?.name ?? "Bot", seed: bot?.avatarSeed || id };
  });
  const current = botsHere.find((bot) => bot.id === agentId);
  const working = Boolean(conversation?.work?.length);
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
          headerTitle: () => (
            <View className="flex-row items-center gap-2">
              <BotOrb
                seed={current?.seed ?? ""}
                name={current?.name ?? "Bot"}
                size={28}
                state={working ? "working" : "idle"}
              />
              <Text variant="label" numberOfLines={1} className="max-w-48">
                {conversation?.name ?? current?.name ?? ""}
              </Text>
            </View>
          ),
          headerRight: () =>
            agentId ? (
              <IconButton
                icon={IconSettings}
                label={`${current?.name ?? "Bot"} settings`}
                size="sm"
                onPress={() =>
                  router.push({ pathname: "/bot", params: { botId: agentId } })
                }
              />
            ) : null,
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
                      ? "border-foreground/30 bg-fill"
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
          className="flex-1"
          inverted
          data={items}
          keyExtractor={(item) => item.key}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-3 px-4 py-4"
          ListHeaderComponent={
            sending ? (
              <Message from="person" text={sending} pending />
            ) : undefined
          }
          renderItem={({ item }) =>
            item.kind === "day" ? (
              <MessageDay label={item.label} />
            ) : (
              <MessageLine message={item.message} />
            )
          }
          ListEmptyComponent={
            history.data ? (
              <EmptyState
                title={`Say hello to ${current?.name ?? "this Bot"}`}
                description="Ask it for something, and it reports back here."
              />
            ) : undefined
          }
        />
        <View
          className="gap-2 px-3 pt-1"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
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
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** One line of the conversation, by who said it. A role this app doesn't know reads as an event. */
function MessageLine({ message }: { message: ConversationMessage }) {
  if (message.role === "person")
    return <Message from="person" text={message.text} />;
  if (message.role === "bot" && message.text)
    return <Message from="bot" text={message.text} />;
  if (message.role === "bot" || message.role === "tool")
    return (
      <MessageEvent
        icon={IconTool}
        text={
          message.role === "tool" && message.text
            ? message.text
            : message.toolCalls && message.toolCalls > 1
              ? `Used ${message.toolCalls} tools.`
              : "Used a tool."
        }
      />
    );
  return message.text ? <MessageEvent text={message.text} /> : null;
}
