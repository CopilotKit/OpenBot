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
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, FlatList, Pressable, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
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
  Icon,
  KeyboardBar,
  Message,
  MessageDay,
  MessageEvent,
  MessageWorking,
  Notice,
  Screen,
  Text,
} from "../src/components";
import { IconAlertCircle, IconChevronRight, IconTool } from "../src/icons";
import { conversationOf, showConversation } from "../src/on-screen";
import { measure, useOrbFlight, type ViewHandle } from "../src/orb-flight";
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
  // The orb an empty conversation opens with, and its place in the header: the first message flies it up.
  const introOrb = useRef<ViewHandle>(null);
  const headerOrb = useRef<ViewHandle>(null);
  const fly = useOrbFlight();
  const keyboard = useReanimatedKeyboardAnimation();
  const aboveKeyboard = useAnimatedStyle(() => ({
    paddingBottom: Math.abs(keyboard.height.value),
  }));
  const [flying, setFlying] = useState(false);
  const [revealed, setRevealed] = useState(false);
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
  // Two or more Bots is a group: one transcript for all of them, read and written without naming one Bot.
  const isGroup = (conversation?.botIds.length ?? 0) > 1;
  const loadHistory = useCallback(
    () =>
      listConversationMessages(ORGANIZATION_ID, channelId ?? "", {
        ...(isGroup ? {} : { botId: agentId }),
        limit: 200,
      }),
    [channelId, agentId, isGroup],
  );
  const history = useLoad(
    loadHistory,
    Boolean(session && conversation && (isGroup || agentId)),
  );
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
  // Who said a line: in a group, the Bot the message names; elsewhere, the one Bot.
  const speakerOf = (message: ConversationMessage): Speaker => {
    const bot =
      (isGroup && botsHere.find((item) => item.id === message.botId)) ||
      current;
    return { seed: bot?.seed ?? "", name: bot?.name ?? "Bot" };
  };
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
  // A conversation with something in it shows who it is with in the header from the start.
  useEffect(() => {
    if (items.length > 0 && !flying) setRevealed(true);
  }, [items.length, flying]);
  const empty =
    Boolean(history.data && current) && items.length === 0 && !sending;
  if (!session && !isPending) return <Redirect href="/" />;

  async function send() {
    if (!text.trim() || (!agentId && !isGroup) || sending) return;
    const pendingText = text;
    // The first message: the Bot's orb leaves the middle of the page and settles into the header.
    if (empty && current && !revealed) {
      const [from, to] = await Promise.all([
        measure(introOrb.current),
        measure(headerOrb.current),
      ]);
      if (from && to) {
        setFlying(true);
        void fly({ seed: current.seed, name: current.name, from, to }).then(
          () => {
            setRevealed(true);
            setFlying(false);
          },
        );
      } else setRevealed(true);
    }
    setSending(pendingText);
    // What they send shows at once, wherever they had scrolled to: the newest end is offset 0.
    list.current?.scrollToOffset({ offset: 0, animated: true });
    setError("");
    setText("");
    try {
      await sendConversationMessage(ORGANIZATION_ID, channelId, {
        id: Crypto.randomUUID(),
        text: pendingText,
        // A group's message goes to every Bot in it; another conversation's to its one Bot.
        ...(isGroup ? {} : { botId: agentId }),
      });
      await history.refresh();
    } catch (failure) {
      // What they wrote goes back in the box, so nothing is lost; a first message that didn't go leaves the
      // conversation as it was, its Bot in the middle of the page.
      setText(pendingText);
      if (items.length === 0) setRevealed(false);
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
                onPress={() =>
                  isGroup
                    ? router.push({
                        pathname: "/conversation-info",
                        params: { channelId },
                      })
                    : router.push({
                        pathname: "/bot",
                        params: { botId: agentId },
                      })
                }
                bots={botsHere}
                current={agentId}
                working={working}
                conversationName={conversation?.name}
                revealed={revealed}
                orbRef={headerOrb}
              />
            ) : null,
        }}
      />
      {/*
       * The page makes room for the keyboard by its own height: the conversation reaches the bottom of the window
       * on both platforms, so the message box rides exactly on the keyboard. (A KeyboardAvoidingView measured itself
       * from under the header on Android and left the box behind the keyboard.)
       */}
      <Animated.View style={aboveKeyboard} className="flex-1">
        <View className="flex-1">
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
                  bot={speakerOf(item.message)}
                  named={isGroup}
                  onReview={() =>
                    router.push({
                      pathname: "/approvals",
                      params: { channelId },
                    })
                  }
                />
              )
            }
          />
          {/* An empty conversation opens on the Bot: its orb, its name and what it does, in the middle of the page. */}
          {empty && current ? (
            <Animated.View
              pointerEvents="none"
              exiting={FadeOut.duration(180)}
              className="absolute inset-0 items-center justify-center gap-4 px-10"
            >
              <View className="flex-row">
                <View
                  ref={introOrb}
                  collapsable={false}
                  style={{ opacity: flying ? 0 : 1 }}
                >
                  <BotOrb seed={current.seed} name={current.name} size={88} />
                </View>
                {/* A group shows each of its Bots, the one the flight carries up first. */}
                {isGroup
                  ? botsHere
                      .filter((bot) => bot.id !== current.id)
                      .slice(0, 2)
                      .map((bot) => (
                        <View key={bot.id} className="-ml-6">
                          <BotOrb seed={bot.seed} name={bot.name} size={88} />
                        </View>
                      ))
                  : null}
              </View>
              <View className="items-center gap-1.5">
                <Text variant="title" className="text-center">
                  {isGroup
                    ? botsHere.map((bot) => bot.name).join(" & ")
                    : current.name}
                </Text>
                {isGroup ? (
                  <Text tone="muted" className="text-center">
                    A group conversation: every Bot here reads what you send,
                    and each answers in turn.
                  </Text>
                ) : current.about ? (
                  <Text tone="muted" className="text-center">
                    {current.about}
                  </Text>
                ) : null}
              </View>
            </Animated.View>
          ) : null}
        </View>
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
              placeholder={
                isGroup
                  ? "Message the group"
                  : `Message ${current?.name ?? "this Bot"}`
              }
              disabled={!conversation?.active || (!agentId && !isGroup)}
              sending={Boolean(sending)}
              autoFocus={Boolean(draft)}
            />
          </View>
        </KeyboardBar>
      </Animated.View>
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
  named,
  onReview,
}: {
  message: ConversationMessage;
  bot: Speaker;
  /** In a group, each Bot's reply carries its orb and name, as the web app's group conversation does. */
  named?: boolean;
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
      named ? (
        <View className="gap-1">
          <View className="flex-row items-center gap-2">
            <BotOrb seed={bot.seed} name={bot.name} size={20} />
            <Text variant="caption" tone="muted" className="font-medium">
              {bot.name}
            </Text>
          </View>
          <View className="pl-7">
            <Message from="bot" text={message.text} />
          </View>
        </View>
      ) : (
        <Message from="bot" text={message.text} />
      )
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
 * breathes while the conversation is at work. An empty conversation keeps it hidden: its Bot is in
 * the middle of the page until the first message flies the orb up to `orbRef`, the current Bot's
 * place here.
 */
function ConversationHeading({
  onPress,
  bots,
  current,
  working,
  conversationName,
  revealed,
  orbRef,
}: {
  /** Opens who the conversation is with: the Bot's page, or a group's details. */
  onPress: () => void;
  bots: { id: string; name: string; seed: string }[];
  current: string;
  working: boolean;
  conversationName?: string;
  revealed: boolean;
  orbRef: RefObject<ViewHandle | null>;
}) {
  const names =
    bots.length > 2
      ? `${bots[0]?.name}, ${bots[1]?.name} and ${bots.length - 2} more`
      : bots.map((bot) => bot.name).join(" & ");
  const shown = useSharedValue(revealed ? 1 : 0);
  useEffect(() => {
    shown.value = revealed ? withTiming(1, { duration: 220 }) : 0;
  }, [revealed, shown]);
  // The orbs appear at once, where the flying one lands; the names follow it in.
  const orbs = useAnimatedStyle(() => ({ opacity: shown.value > 0 ? 1 : 0 }));
  const label = useAnimatedStyle(() => ({ opacity: shown.value }));
  return (
    // The header is the way in to who the conversation is with, as iMessage's is: tap it.
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[conversationName, `with ${names}`]
        .filter(Boolean)
        .join(", ")}
      accessibilityHint={
        bots.length > 1 ? "Shows the Bots in this group" : "Opens the Bot"
      }
      hitSlop={8}
      onPress={onPress}
      className="items-center gap-0.5 active:opacity-60"
    >
      <Animated.View style={orbs} className="flex-row">
        {bots.slice(0, 3).map((bot, index) => (
          <View
            key={bot.id}
            ref={bot.id === current ? orbRef : undefined}
            collapsable={false}
            className={cn(index > 0 && "-ml-2")}
          >
            <BotOrb
              seed={bot.seed}
              name={bot.name}
              size={26}
              state={working && index === 0 ? "working" : "idle"}
            />
          </View>
        ))}
      </Animated.View>
      <Animated.View style={label} className="flex-row items-center gap-0.5">
        <Text numberOfLines={1} className="max-w-52 font-medium text-xs">
          {names}
        </Text>
        <Icon icon={IconChevronRight} size={11} color="accent-muted" />
      </Animated.View>
    </Pressable>
  );
}
