import { Redirect, useLocalSearchParams } from "expo-router";
import { Button } from "heroui-native/button";
import { Input } from "heroui-native/input";
import { Label } from "heroui-native/label";
import { TextField } from "heroui-native/text-field";
import { useCallback, useEffect, useState } from "react";
import { AppState, Share, View } from "react-native";
import { ApiError, everyPage, ME, ORGANIZATION_ID } from "../src/api";
import { listConversations } from "../src/api/generated/conversations/conversations";
import {
  confirmPhoneDestination,
  deleteDestination,
  linkChatDestination,
  verifyPhoneDestination,
} from "../src/api/generated/destinations/destinations";
import type { ChatLinkCode } from "../src/api/generated/model";
import { listNotificationTransports } from "../src/api/generated/notification-settings/notification-settings";
import { authClient } from "../src/auth";
import { loadDestinations } from "../src/bot-context";
import { isPhoneNumber, isVerificationCode } from "../src/bot-settings";
import {
  ChoiceList,
  Notice,
  Row,
  Rows,
  ScrollScreen,
  Section,
  Text,
} from "../src/components";
import {
  IconBrandSlack,
  IconBrandTeams,
  IconDeviceMobileMessage,
  type TablerIcon,
} from "../src/icons";
import { useAction } from "../src/use-action";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";

type Transport = "slack" | "teams" | "sms";
type Platform = "slack" | "teams";

const TRANSPORTS: Transport[] = ["slack", "teams", "sms"];

const TRANSPORT: Record<
  Transport,
  { name: string; link: string; icon: TablerIcon; summary: string }
> = {
  slack: {
    name: "Slack",
    link: "Link Slack",
    icon: IconBrandSlack,
    summary: "Continue a conversation from Slack.",
  },
  teams: {
    name: "Microsoft Teams",
    link: "Link Microsoft Teams",
    icon: IconBrandTeams,
    summary: "Continue a conversation from Microsoft Teams.",
  },
  sms: {
    name: "Text messages",
    link: "Connect a phone",
    icon: IconDeviceMobileMessage,
    summary: "Continue a conversation by text message.",
  },
};

/** A link code made here, with the conversation it links. */
type HeldLink = ChatLinkCode & { conversationId: string };

/*
 * What waits on the person while they are away in Slack, Teams or their messages: the link code they
 * are to send, and the phone verification whose code is on its way. Kept for as long as the app runs,
 * so leaving this screen and coming back keeps them.
 */
const heldLinks = new Map<string, HeldLink>();
const pendingPhones = new Map<
  string,
  { verificationId: string; conversationId: string }
>();

const isTransport = (value: string): value is Transport =>
  value === "slack" || value === "teams" || value === "sms";

/**
 * Reaching you, as the web app's for one Bot: the places outside OpenBot its conversations continue,
 * each with Disconnect, and a way to connect another. Linking Slack or Microsoft Teams answers with a
 * message to send the OpenBot app there; the destination appears here once it is sent, read again
 * when the app comes back to the front. A phone is texted a code to type back here.
 */
export default function BotReachScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session && botId);
  const action = useAction();
  const loadConnected = useCallback(() => loadDestinations(botId), [botId]);
  const connected = useLoad(loadConnected, signedIn);
  const loadTransports = useCallback(
    () =>
      everyPage(
        (page) => listNotificationTransports(ORGANIZATION_ID, page),
        (page) => page.notificationTransports,
      ),
    [],
  );
  const transports = useLoad(loadTransports, signedIn);
  const loadConversations = useCallback(
    () =>
      everyPage(
        (page) => listConversations(ORGANIZATION_ID, { ...page, botId }),
        (page) => page.conversations,
      ),
    [botId],
  );
  const conversations = useLoad(loadConversations, signedIn);
  const pull = usePull(
    connected.refresh,
    transports.refresh,
    conversations.refresh,
  );
  // Back from Slack, Teams or the phone's messages: what was connected there shows at once.
  const refreshConnected = connected.refresh;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshConnected();
    });
    return () => subscription.remove();
  }, [refreshConnected]);
  const [connecting, setConnecting] = useState<Transport | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  // Bumped when a held code or verification changes, so the screen draws it.
  const [, setHeld] = useState(0);
  if (!session && !isPending) return <Redirect href="/" />;

  const pending = pendingPhones.get(botId);
  const heldLink = (platform: Platform) => {
    const held = heldLinks.get(`${botId}:${platform}`);
    return held && Date.parse(held.expiresAt) > Date.now() ? held : undefined;
  };
  const available = new Set(
    (transports.data ?? [])
      .map((transport) => transport.id)
      .filter(isTransport),
  );
  const opens = (transport: Transport) =>
    available.has(transport) || (transport === "sms" && pending !== undefined);
  const summary = (transport: Transport) => {
    if (transport === "sms" && pending)
      return "A verification code is on its way. Enter it to finish.";
    if (transport !== "sms" && heldLink(transport))
      return "Your link code is ready to send. Open this to see it again.";
    if (opens(transport)) return TRANSPORT[transport].summary;
    return transport === "sms"
      ? "Text messages aren't set up yet. An admin has to turn them on first."
      : "Not set up yet. An admin has to turn on Slack and Teams first.";
  };
  const chats = (conversations.data ?? []).filter(
    (conversation) =>
      conversation.active && conversation.botIds.includes(botId),
  );
  const chatName = (id: string) =>
    conversations.data?.find((conversation) => conversation.id === id)?.name;
  const open = (transport: Transport) => {
    setConnecting(transport);
    const held =
      transport === "sms"
        ? pendingPhones.get(botId)?.conversationId
        : heldLink(transport)?.conversationId;
    setConversationId(held ?? chats[0]?.id ?? "");
    setCode("");
  };

  const disconnect = (id: string) =>
    void action.run(`remove:${id}`, async () => {
      try {
        await deleteDestination(ORGANIZATION_ID, ME, id);
      } catch (failure) {
        // One already disconnected is not found, which is done.
        if (!(failure instanceof ApiError && failure.status === 404))
          throw failure;
      }
      await connected.refresh();
    });
  const link = (platform: Platform) =>
    void action.run("link", async () => {
      const made = await linkChatDestination(ORGANIZATION_ID, ME, {
        platform,
        conversationId,
        botId,
      });
      heldLinks.set(`${botId}:${platform}`, { ...made, conversationId });
      setHeld((now) => now + 1);
    });
  const sendCode = () =>
    void action.run("verify", async () => {
      const verification = await verifyPhoneDestination(ORGANIZATION_ID, ME, {
        phone: phone.trim(),
        conversationId,
        botId,
      });
      pendingPhones.set(botId, {
        verificationId: verification.verificationId,
        conversationId,
      });
      setHeld((now) => now + 1);
    });
  const confirm = () =>
    void action.run("confirm", async () => {
      if (!pending) return;
      await confirmPhoneDestination(ORGANIZATION_ID, ME, {
        verificationId: pending.verificationId,
        code: code.trim(),
      });
      pendingPhones.delete(botId);
      setCode("");
      setConnecting(null);
      await connected.refresh();
    });

  const held =
    connecting && connecting !== "sms" ? heldLink(connecting) : undefined;
  const minutesLeft = held
    ? Math.max(1, Math.ceil((Date.parse(held.expiresAt) - Date.now()) / 60_000))
    : 0;

  return (
    <ScrollScreen refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Text tone="muted" className="px-1 text-sm">
        Continue a conversation with this Bot in Slack, Microsoft Teams, or by
        text message.
      </Text>
      <Notice
        message={
          action.error ||
          connected.error ||
          transports.error ||
          conversations.error
        }
      />
      <Section title="Connected destinations">
        {connected.data?.length === 0 ? (
          <Text tone="muted" className="px-1 text-sm">
            No destinations connected.
          </Text>
        ) : null}
        {connected.data?.length ? (
          <Rows>
            {connected.data.map((destination) => {
              const known = isTransport(destination.transport)
                ? TRANSPORT[destination.transport]
                : undefined;
              return (
                <Row
                  key={destination.id}
                  icon={known?.icon}
                  title={
                    destination.transport === "sms" || !known
                      ? destination.address
                      : known.name
                  }
                  description={[
                    chatName(destination.conversationId),
                    destination.optedOutAt
                      ? "You texted STOP. Text START to resume."
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  trailing={
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={Boolean(action.busy)}
                      onPress={() => disconnect(destination.id)}
                    >
                      Disconnect
                    </Button>
                  }
                />
              );
            })}
          </Rows>
        ) : null}
      </Section>
      <Section title="Connect a conversation">
        <Text tone="muted" className="px-1 text-sm">
          In a Slack or Teams channel that others can read, the Bot replies to
          you in a direct message.
        </Text>
        {transports.data ? (
          <Rows>
            {TRANSPORTS.map((transport) => (
              <Row
                key={transport}
                icon={TRANSPORT[transport].icon}
                title={TRANSPORT[transport].link}
                description={summary(transport)}
                onPress={opens(transport) ? () => open(transport) : undefined}
              />
            ))}
          </Rows>
        ) : null}
      </Section>
      {connecting ? (
        <Section title={TRANSPORT[connecting].link}>
          <Text tone="muted" className="px-1 text-sm">
            Each account or phone number works with one conversation at a time.
            Linking it here moves it from the one it's linked to now.
          </Text>
          {chats.length === 0 ? (
            <Text tone="muted" className="px-1 text-sm">
              Start a chat with this Bot first, then connect it here.
            </Text>
          ) : (
            <ChoiceList
              label="Conversation"
              options={chats.map((chat) => ({
                value: chat.id,
                label: chat.name,
              }))}
              value={conversationId}
              onChange={setConversationId}
            />
          )}
          {connecting === "sms" ? (
            <View className="gap-3">
              <TextField>
                <Label>Phone number</Label>
                <Input
                  accessibilityLabel="Phone number"
                  placeholder="+15551234567"
                  keyboardType="phone-pad"
                  autoComplete="tel"
                  value={phone}
                  onChangeText={setPhone}
                />
              </TextField>
              <Button
                size="sm"
                variant={pending ? "secondary" : "primary"}
                className="self-end"
                isDisabled={
                  !conversationId ||
                  !available.has("sms") ||
                  !isPhoneNumber(phone) ||
                  Boolean(action.busy)
                }
                onPress={sendCode}
              >
                Send verification code
              </Button>
              {pending ? (
                <>
                  <TextField>
                    <Label>Verification code</Label>
                    <Input
                      accessibilityLabel="Verification code"
                      keyboardType="number-pad"
                      autoComplete="one-time-code"
                      textContentType="oneTimeCode"
                      value={code}
                      onChangeText={setCode}
                    />
                  </TextField>
                  <Button
                    size="sm"
                    className="self-end"
                    isDisabled={
                      !isVerificationCode(code) || Boolean(action.busy)
                    }
                    onPress={confirm}
                  >
                    Confirm phone
                  </Button>
                </>
              ) : null}
            </View>
          ) : (
            <View className="gap-3">
              {held ? (
                <Rows iconless>
                  <Row
                    title={held.command}
                    description={`Send this message to the OpenBot app in a direct message in ${TRANSPORT[connecting].name} within ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"}. It links that account to this conversation and Bot.`}
                    trailing={
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() =>
                          void Share.share({ message: held.command })
                        }
                      >
                        Share
                      </Button>
                    }
                  />
                </Rows>
              ) : null}
              <Button
                size="sm"
                variant={held ? "secondary" : "primary"}
                className="self-end"
                isDisabled={
                  !conversationId ||
                  !available.has(connecting) ||
                  Boolean(action.busy)
                }
                onPress={() => link(connecting)}
              >
                {held ? "Make a new code" : TRANSPORT[connecting].link}
              </Button>
            </View>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onPress={() => setConnecting(null)}
          >
            Close
          </Button>
        </Section>
      ) : null}
    </ScrollScreen>
  );
}
