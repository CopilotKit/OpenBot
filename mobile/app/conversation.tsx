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
  ApiError,
  type ConversationMessage,
  everyBot,
  loadApprovalInbox,
  ME,
  ORGANIZATION_ID,
  readDeployment,
} from "../src/api";
import { decideApproval } from "../src/api/generated/approvals/approvals";
import { callComponentFunction } from "../src/api/generated/components/components";
import {
  getConversation,
  listConversationMessages,
  markConversationRead,
  sendConversationMessage,
  stopConversationRun,
} from "../src/api/generated/conversations/conversations";
import type { Approval } from "../src/api/generated/model";
import {
  approvalChange,
  approvalChoices,
  approvalDetails,
  approvalTitle,
  DECISION_LABELS,
  type PhoneDecision,
} from "../src/approval-words";
import { authClient } from "../src/auth";
import { useChatFiles, useChatModel } from "../src/chat-extras";
import {
  BotOrb,
  Composer,
  cn,
  DecisionCard,
  Icon,
  KeyboardBar,
  Message,
  MessageDay,
  MessageEvent,
  MessageWorking,
  Notice,
  Screen,
  StepsLine,
  Text,
} from "../src/components";
import {
  answersIn,
  DrawnCards,
  DrawnContext,
  type DrawnSetting,
  drawable,
} from "../src/gallery";
import {
  IconAlertCircle,
  IconChevronRight,
  IconClock,
  IconTool,
} from "../src/icons";
import {
  arriving,
  asMessages,
  caughtUp,
  type LiveRuns,
  liveAnswers,
  reduce,
  sentAgain,
  settle,
  stopOffer,
} from "../src/live-run";
import { conversationOf, showConversation } from "../src/on-screen";
import { measure, useOrbFlight, type ViewHandle } from "../src/orb-flight";
import { connectAiRouteFor } from "../src/setup";
import { useLoad } from "../src/use-load";
import { watchConversationLive } from "../src/watch-conversation";
import { dayAndTime } from "../src/when";

/** Messages this far apart get the day and time over the later one. */
const PAUSE_MS = 30 * 60 * 1000;

type Item =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: ConversationMessage }
  | { kind: "steps"; key: string; steps: string[] }
  | { kind: "approval"; key: string; request: Approval };

/**
 * A step a Bot took rather than something it said: a tool's own line, or a finished reply that only
 * called tools. A run of them folds into one line, as the web app's transcript folds them. A reply
 * that drew cards is not a step: its cards are drawn.
 */
function stepWords(message: ConversationMessage): string[] | null {
  if (message.role === "tool") return [message.text || "Used a tool."];
  if (drawable(message).length > 0) return null;
  if (
    message.role === "bot" &&
    !message.text &&
    message.status !== "queued" &&
    message.status !== "running" &&
    message.status !== "waiting" &&
    message.status !== "failed"
  )
    return message.toolCalls && message.toolCalls > 1
      ? [`Used ${message.toolCalls} tools.`]
      : ["Used a tool."];
  return null;
}

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
  // A message the server took, drawn until the messages read back hold it: a Bot can start on it before they do.
  const [delivered, setDelivered] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const list = useRef<FlatList<Item>>(null);
  // The orb an empty conversation opens with, and its place in the header: the first message flies it up.
  const introOrb = useRef<ViewHandle>(null);
  const headerOrb = useRef<ViewHandle>(null);
  const fly = useOrbFlight();
  // What goes with the next message: files, held by the server as they are picked, and the model it runs on.
  const chatFiles = useChatFiles(channelId ?? "");
  const chatModel = useChatModel(
    channelId ?? "",
    Boolean(session && channelId),
  );
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
   * The Bot's runs as they happen (../src/watch-conversation.ts): "Working…" the moment one starts, and its words as they
   * come, where the reloads above would show them all at once some seconds after. When a run ends its messages are read
   * again at once, and the live copy goes. A server or a connection that can't do this leaves the reloads as they were.
   */
  const [live, setLive] = useState<LiveRuns>([]);
  const liveNow = useRef(live);
  liveNow.current = live;
  const watcher = useRef<{ reconnect(): void } | null>(null);
  // The runs Stop was pressed for: they are ending on the server, and the button waits for them.
  const [stopAsked, setStopAsked] = useState<ReadonlySet<string>>(new Set());
  // Read through a ref, so the socket isn't opened again each time the reloads change who they read for.
  const reload = useRef({
    history: history.refresh,
    conversation: channels.refresh,
  });
  reload.current = { history: history.refresh, conversation: channels.refresh };
  const person = session?.user.id;
  useEffect(() => {
    if (!channelId || !person) return;
    setLive([]);
    setDelivered(null);
    setStopAsked(new Set());
    const refreshHistory = () => reload.current.history();
    const refreshConversation = () => reload.current.conversation();
    // What the thread replays when the socket joins is gathered and drawn once, not event by event.
    let replay: LiveRuns | null = null;
    const ended = () =>
      void Promise.all([refreshHistory(), refreshConversation()]).then(() =>
        setLive(settle),
      );
    const watch = watchConversationLive(channelId, {
      onEvent(event, replayed) {
        if (replayed) {
          replay = reduce(replay ?? liveNow.current, event);
          return;
        }
        setLive((runs) => reduce(runs, event));
        if (event.type === "RUN_STARTED") void refreshConversation();
        if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR")
          ended();
      },
      onCaughtUp() {
        setLive(caughtUp(replay ?? liveNow.current));
        replay = null;
        // Whatever ended while the socket was away is in the messages now.
        void refreshHistory();
      },
    });
    watcher.current = watch;
    return () => {
      watcher.current = null;
      watch.stop();
    };
  }, [channelId, person]);
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
  // Whether this OpenBot lets a person stop a Bot's run (runStop): Stop is offered only then. Read once per person.
  const [runStop, setRunStop] = useState(false);
  useEffect(() => {
    setRunStop(false);
    if (!person) return;
    let current = true;
    readDeployment(true)
      .then((deployment) => {
        if (current) setRunStop(deployment.runStop === true);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [person]);
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
  const replyUnderway =
    live.some((run) => !run.ended) ||
    (history.data?.messages ?? []).some(
      (message) => message.status === "queued" || message.status === "running",
    );
  // What a Bot asked the person to approve in this chat, decided right here as on the web app.
  const loadInbox = useCallback(() => loadApprovalInbox(), []);
  const inbox = useLoad(loadInbox, Boolean(session));
  const threadId = conversation?.threadId;
  const waitingHere = useMemo(
    () =>
      (inbox.data?.requests ?? []).filter(
        (request) =>
          request.status === "pending" &&
          Boolean(threadId) &&
          request.action.threadId === threadId,
      ),
    [inbox.data, threadId],
  );
  const [deciding, setDeciding] = useState(false);
  async function decide(id: string, decision: PhoneDecision) {
    setDeciding(true);
    setError("");
    try {
      await decideApproval(ORGANIZATION_ID, ME, id, { decision });
      await Promise.all([inbox.refresh(), history.refresh()]);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save your decision. Try again.",
      );
    } finally {
      setDeciding(false);
    }
  }
  /*
   * What the Bot's cards share: which ones are still streaming their arguments, what the person answered the
   * questions among them (a live run's results, else what the read messages say), how a report reads its figures, and
   * the Bots' names.
   */
  const botList = bots.data;
  const readReport = useCallback<NonNullable<DrawnSetting["readReport"]>>(
    async (botId, name, args) => {
      try {
        const result = await callComponentFunction(
          ORGANIZATION_ID,
          botId || agentId,
          "showActivityReport",
          { function: name, arguments: args },
        );
        return result.allowed
          ? { allowed: true, data: result.data }
          : { allowed: false, reason: result.reason ?? undefined };
      } catch (failure) {
        return {
          allowed: false,
          reason:
            failure instanceof Error
              ? failure.message
              : "Couldn't read that data. Try again in a moment.",
        };
      }
    },
    [agentId],
  );
  const drawnSetting = useMemo<DrawnSetting>(() => {
    const answers = answersIn((history.data?.messages ?? []).slice().reverse());
    for (const [id, answer] of liveAnswers(live)) answers.set(id, answer);
    return {
      arriving: arriving(live),
      answers,
      readReport,
      botName: (id) => botList?.find((bot) => bot.id === id)?.name,
    };
  }, [history.data, live, readReport, botList]);
  // Newest first, as the API answers and as an inverted list draws from the bottom up.
  const items = useMemo<Item[]>(() => {
    const read = history.data?.messages ?? [];
    // While the person's own message is still on its way it is drawn last; the Bot's reply joins after it.
    const writing = sending ? [] : asMessages(live, read);
    const mine: ConversationMessage[] =
      delivered && !read.some((message) => message.id === delivered.id)
        ? [
            {
              id: delivered.id,
              role: "person",
              personId: null,
              botId: null,
              text: delivered.text,
              status: "completed",
              createdAt: null,
            },
          ]
        : [];
    const oldestFirst = [...writing, ...mine, ...read].slice().reverse();
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
      const steps = stepWords(message);
      const last = out[out.length - 1];
      if (steps && last?.kind === "steps") last.steps.push(...steps);
      else if (steps)
        out.push({ kind: "steps", key: `steps:${message.id}`, steps });
      else out.push({ kind: "message", key: message.id, message });
    }
    // What a Bot here is waiting on the person to decide sits at the end, where they are reading.
    for (const request of waitingHere)
      out.push({ kind: "approval", key: `approval:${request.id}`, request });
    return out.reverse();
  }, [history.data, waitingHere, live, sending, delivered]);
  // A live reply doesn't say which Bot in a group is writing it: it is named once it is read back.
  const liveIds = useMemo(
    () =>
      new Set(
        asMessages(live, history.data?.messages ?? []).map(
          (message) => message.id,
        ),
      ),
    [live, history.data],
  );
  /*
   * Stop, while a Bot's run here is live and this OpenBot offers it, in a conversation with one Bot: the server keeps
   * no run record for a group, so it could stop nothing there. Every live run is stopped with one press. The runs then
   * end over the socket as usual, and the conversation is read again.
   */
  const offer = stopOffer(live, { runStop, group: isGroup }, stopAsked);
  async function stop() {
    const runs = offer?.runs ?? [];
    if (!channelId || runs.length === 0) return;
    setStopAsked((asked) => new Set([...asked, ...runs]));
    setError("");
    const results = await Promise.allSettled(
      runs.map((runId) =>
        stopConversationRun(ORGANIZATION_ID, channelId, runId),
      ),
    );
    // A run the server no longer knows (404) has nothing left to stop.
    const failed = results.flatMap((result, index) =>
      result.status === "rejected" &&
      !(result.reason instanceof ApiError && result.reason.status === 404)
        ? [{ runId: runs[index] as string, reason: result.reason as unknown }]
        : [],
    );
    if (failed.length === 0) return;
    setStopAsked((asked) => {
      const next = new Set(asked);
      for (const { runId } of failed) next.delete(runId);
      return next;
    });
    const reason = failed[0]?.reason;
    setError(
      reason instanceof Error && reason.message
        ? reason.message
        : "Couldn't stop the Bot. Try again.",
    );
  }
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
      const id = Crypto.randomUUID();
      await sendConversationMessage(ORGANIZATION_ID, channelId, {
        id,
        text: pendingText,
        // A group's message goes to every Bot in it; another conversation's to its one Bot.
        ...(isGroup ? {} : { botId: agentId }),
      });
      setDelivered({ id, text: pendingText });
      // A failure already seen goes once something new is sent, so it isn't drawn after it.
      setLive(sentAgain);
      chatFiles.sent();
      // A conversation's first message gives its socket something to join.
      watcher.current?.reconnect();
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
          <DrawnContext.Provider value={drawnSetting}>
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
              contentContainerClassName="grow justify-end gap-5 px-4 py-5"
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
                ) : item.kind === "steps" ? (
                  <StepsLine steps={item.steps} />
                ) : item.kind === "approval" ? (
                  <ApprovalHere
                    request={item.request}
                    botName={
                      botsHere.find(
                        (bot) => bot.id === item.request.action.botId,
                      )?.name
                    }
                    busy={deciding}
                    onDecide={(decision) =>
                      void decide(item.request.id, decision)
                    }
                  />
                ) : (
                  <MessageLine
                    message={item.message}
                    bot={speakerOf(item.message)}
                    named={isGroup && !liveIds.has(item.message.id)}
                    decidingHere={waitingHere.length > 0}
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
          </DrawnContext.Provider>
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
                {/* A group shows up to four of its Bots, the one the flight carries up first. */}
                {isGroup
                  ? botsHere
                      .filter((bot) => bot.id !== current.id)
                      .slice(0, 3)
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
                    ? botsHere.map((bot) => bot.name).join(", ")
                    : current.name}
                </Text>
                {isGroup ? (
                  <Text tone="muted" className="text-center">
                    A group chat: every Bot here reads what you send, and each
                    answers in turn.
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
              message={
                error ||
                chatFiles.error ||
                channels.error ||
                history.error ||
                undefined
              }
            />
            {conversation && !conversation.active ? (
              <Notice
                tone="info"
                message="This chat has ended. Start a new one from the Bot's page."
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
              onAttach={(from) => void chatFiles.attach(from)}
              files={chatFiles.files}
              onRemoveFile={chatFiles.remove}
              models={chatModel}
              stop={
                offer
                  ? {
                      onStop: () => void stop(),
                      stopping: offer.stopping,
                      label: "Stop the Bot",
                    }
                  : undefined
              }
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
  decidingHere,
  onReview,
}: {
  message: ConversationMessage;
  bot: Speaker;
  /** In a group, each Bot's reply carries its orb and name, as the web app's group conversation does. */
  named?: boolean;
  /** What it waits on is decided in this chat, on its card: the reply only says it is waiting. */
  decidingHere?: boolean;
  /** Opens what the Bot is waiting on: the approval inbox, where its request or question is. */
  onReview: () => void;
}) {
  if (message.role === "person")
    return <Message from="person" text={message.text} />;
  if (message.role === "bot") {
    const unfinished =
      message.status === "queued" || message.status === "running";
    // The cards the Bot drew in this message, under what it said, in the order it drew them.
    const drew = drawable(message).length > 0;
    if (unfinished && !message.text && !drew)
      return (
        <MessageWorking
          seed={bot.seed}
          name={bot.name}
          label={message.status === "queued" ? "Starting…" : "Working…"}
        />
      );
    const content =
      message.text || drew ? (
        <View className="gap-3">
          {message.text ? <Message from="bot" text={message.text} /> : null}
          {drew ? <DrawnCards message={message} /> : null}
        </View>
      ) : null;
    const said = content ? (
      named ? (
        <View className="gap-1">
          <View className="flex-row items-center gap-2">
            <BotOrb seed={bot.seed} name={bot.name} size={20} />
            <Text variant="caption" tone="muted" className="font-medium">
              {bot.name}
            </Text>
          </View>
          <View className="pl-7">{content}</View>
        </View>
      ) : (
        content
      )
    ) : message.toolCalls ? (
      <ToolLine count={message.toolCalls} />
    ) : null;
    // Waiting on the person: one quiet line, as the web app says it; the decision's card is below it in this
    // chat, or, when it isn't one this chat can answer, a link to where it is.
    if (message.status === "waiting")
      return (
        <View className="gap-2">
          {said}
          <View className="flex-row items-start gap-2">
            <View className="pt-0.5">
              <Icon icon={IconClock} size={14} color="accent-muted" />
            </View>
            <Text tone="muted" className="flex-1 text-sm leading-5">
              {message.reason || `${bot.name} is waiting for you.`}
              {decidingHere ? null : (
                <>
                  {"  "}
                  <Text
                    accessibilityRole="link"
                    onPress={onReview}
                    className="font-medium text-foreground underline"
                  >
                    Review
                  </Text>
                </>
              )}
            </Text>
          </View>
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
          <ConnectAi reasons={[message.text, message.reason]} />
        </View>
      );
    if (message.declined && message.text)
      return (
        <View className="gap-2">
          <MessageEvent text={message.text} />
          <ConnectAi reasons={[message.text, message.reason]} />
        </View>
      );
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

/**
 * A Bot's request to act, waiting in this chat, on the web app's decision card: what it wants to do,
 * why it asks, what it would send, and the answers the server takes.
 */
function ApprovalHere({
  request,
  botName,
  busy,
  onDecide,
}: {
  request: Approval;
  botName?: string;
  busy: boolean;
  onDecide: (decision: PhoneDecision) => void;
}) {
  const change = approvalChange(request.action.target);
  const choices = approvalChoices(request.action);
  const standing = choices.find((choice) => choice === "allow_always");
  return (
    <DecisionCard
      title={approvalTitle(request.action, botName)}
      caption={request.action.policy?.reason ?? change?.summary}
      details={change ? [] : approvalDetails(request.action.args)}
      busy={busy}
      choices={choices
        .filter((choice) => choice !== "allow_always")
        .map((choice) => ({
          label: DECISION_LABELS[choice],
          primary: choice !== "deny",
          onPress: () => onDecide(choice),
        }))}
      standing={
        standing
          ? {
              label: DECISION_LABELS[standing],
              onPress: () => onDecide(standing),
            }
          : undefined
      }
    />
  );
}

/**
 * "Connect your AI", under a reply that failed because no AI is connected (the server's own sentence, ../src/setup.ts),
 * to the screen that connects one. Under any other failure, nothing.
 */
function ConnectAi({ reasons }: { reasons: (string | null | undefined)[] }) {
  const route = reasons
    .map((reason) => connectAiRouteFor(reason))
    .find((found) => found !== null);
  if (!route) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="self-start"
      onPress={() => router.push(route)}
    >
      Connect your AI
    </Button>
  );
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
  const names = bots.map((bot) => bot.name).join(", ");
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
      // Sized to sit inside the bar's own height on iOS, clear of the Dynamic Island: a small orb, a line of
      // name, and a nudge down to the bar's middle.
      className="items-center pt-1 active:opacity-60"
    >
      <Animated.View style={orbs} className="flex-row">
        {bots.slice(0, 4).map((bot, index) => (
          <View
            key={bot.id}
            ref={bot.id === current ? orbRef : undefined}
            collapsable={false}
            className={cn(index > 0 && "-ml-2")}
          >
            <BotOrb
              seed={bot.seed}
              name={bot.name}
              size={22}
              state={working && index === 0 ? "working" : "idle"}
            />
          </View>
        ))}
      </Animated.View>
      <Animated.View style={label} className="flex-row items-center gap-0.5">
        <Text
          numberOfLines={1}
          className="max-w-52 font-medium text-[11px] leading-[14px]"
        >
          {names}
        </Text>
        <Icon icon={IconChevronRight} size={10} color="accent-muted" />
      </Animated.View>
    </Pressable>
  );
}
