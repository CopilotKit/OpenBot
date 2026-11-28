import {
  IconBrandSlack,
  IconBrandTeams,
  IconBrandTelegram,
  IconChevronRight,
  IconDeviceMobileMessage,
  IconSend,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  type ChatLink,
  confirmSmsMutationOptions,
  destinationsQueryOptions,
  removeDeliveryBindingMutationOptions,
  startChatLinkMutationOptions,
  startSmsMutationOptions,
  startTelegramMutationOptions,
  type TelegramLink,
  type Transports,
  transportsQueryOptions,
} from "@/lib/delivery";
import { failureSaid } from "@/lib/load-failure";
import { queryClient } from "@/query-client";

/**
 * The phone verification waiting for its code, kept for the tab.
 *
 * Only the challenge id lives in the page, and the text with the code arrives on the person's
 * phone a moment after they may have looked away: leaving and coming back used to drop the box to
 * type it into, with no way to confirm the code they had just been sent.
 */
const PENDING_SMS = "openbot.reachability.pendingSms";
function readPending(): string {
  try {
    return sessionStorage.getItem(PENDING_SMS) ?? "";
  } catch {
    return "";
  }
}
function writePending(id: string) {
  try {
    if (id) sessionStorage.setItem(PENDING_SMS, id);
    else sessionStorage.removeItem(PENDING_SMS);
  } catch {
    /* A browser that keeps nothing still confirms within the visit. */
  }
}

/** Ways a person can connect a conversation from Reaching you. */
type ConnectTransport = "slack" | "teams" | "sms" | "telegram";
type ChatPlatform = ChatLink["platform"];

/** A one-time link message, the conversation and Bot it links, and when it stops working. */
type HeldLink = ChatLink & {
  channelId: string;
  agentId: string;
};

type HeldTelegram = TelegramLink & {
  channelId: string;
  agentId: string;
};

const TRANSPORT: Record<
  ConnectTransport,
  { link: string; icon: typeof IconBrandSlack; summary: string; title: string }
> = {
  slack: {
    link: "Link Slack",
    icon: IconBrandSlack,
    summary: "Continue a conversation from Slack.",
    title: "Slack",
  },
  teams: {
    link: "Link Microsoft Teams",
    icon: IconBrandTeams,
    summary: "Continue a conversation from Microsoft Teams.",
    title: "Microsoft Teams",
  },
  telegram: {
    link: "Connect Telegram",
    icon: IconBrandTelegram,
    summary: "Continue a conversation from your Telegram bot.",
    title: "Telegram",
  },
  sms: {
    link: "Connect a phone",
    icon: IconDeviceMobileMessage,
    summary: "Continue a conversation by text message.",
    title: "SMS",
  },
};

function destinationLook(transport: string) {
  if (transport in TRANSPORT) return TRANSPORT[transport as ConnectTransport];
  return {
    link: transport,
    icon: IconSend,
    summary: transport,
    title: transport,
  };
}

/**
 * Continuing a conversation in Slack, Microsoft Teams, Telegram or by text message. Given a Bot,
 * only that Bot's conversations and destinations, and no Bot to pick.
 *
 * The destinations already connected are rows with a Disconnect each. Connecting one is a row per
 * transport that opens a dialog, because it is several inputs — a conversation, then an account, a
 * bot token or a phone number — and the answer is a code to send back.
 */
export function ReachingYou({ agentId: fixedBot }: { agentId?: string }) {
  const connected = useQuery(destinationsQueryOptions());
  const transports = useQuery(transportsQueryOptions());
  // People read Bots by name; the id is what the list used to show.
  const botName = useBotNames();
  const [challengeId, setChallengeId] = useState(readPending);
  useEffect(() => writePending(challengeId), [challengeId]);
  const [connecting, setConnecting] = useState<ConnectTransport | null>(null);
  /*
   * The last link message per platform, held here rather than in the dialog: the dialog unmounts
   * when it closes, and the code is only useful once it has been sent from Slack or Teams, which is
   * exactly when somebody closes it to go and do that. Dropped once it has expired.
   */
  const [links, setLinks] = useState<Partial<Record<ChatPlatform, HeldLink>>>(
    {},
  );
  const [telegramLink, setTelegramLink] = useState<HeldTelegram | undefined>();
  const heldLink = (transport: ConnectTransport) => {
    if (transport === "sms") return undefined;
    if (transport === "telegram") {
      return telegramLink && telegramLink.expiresAt > Date.now()
        ? telegramLink
        : undefined;
    }
    const held = links[transport];
    return held && held.expiresAt > Date.now() ? held : undefined;
  };
  const remove = useMutation(removeDeliveryBindingMutationOptions(queryClient));
  const destinations = connected.data?.filter(
    (destination) => fixedBot === undefined || destination.botId === fixedBot,
  );
  const listError = connected.error ?? remove.error;
  /*
   * A transport the deployment cannot reach is a row that says why rather than one that opens a
   * dialog whose every button is disabled. A phone with a code already on its way stays reachable,
   * so the code can still be confirmed.
   */
  const open = (transport: ConnectTransport) =>
    !!transports.data?.[transport] ||
    (transport === "sms" && challengeId !== "");
  const summary = (transport: ConnectTransport) => {
    if (transport === "sms" && challengeId) {
      return "A verification code is on its way. Enter it to finish.";
    }
    if (heldLink(transport)) {
      return "Your link code is ready to send. Open this to see it again.";
    }
    if (open(transport)) return TRANSPORT[transport].summary;
    if (transport === "sms")
      return "Text messages aren't set up yet. An admin has to turn them on first.";
    if (transport === "telegram")
      return "Telegram isn't set up yet. An admin has to turn it on first.";
    return "Not set up yet. An admin has to turn on Slack and Teams first.";
  };

  return (
    <>
      {fixedBot === undefined ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Your devices, recent deliveries, and where each kind of update goes
          are in{" "}
          <Link
            className="underline underline-offset-4"
            to="/settings/notifications"
          >
            Settings → Notifications
          </Link>
          .
        </p>
      ) : null}
      <PageSection title="Connected destinations">
        {listError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failureSaid(listError)}
          </p>
        ) : null}
        {connected.isPending || !destinations ? null : destinations.length ===
          0 ? (
          <PageEmpty icon={IconSend} title="No destinations connected" />
        ) : (
          <PageRows>
            {destinations.map((binding, index) => {
              const look = destinationLook(binding.transport);
              const Icon = look.icon;
              return (
                <Fragment key={binding.id}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      <Icon />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {binding.transport === "sms"
                          ? binding.address
                          : look.title}
                      </ItemTitle>
                      <ItemDescription>
                        {botName(binding.botId)}
                        {binding.optedOutAt
                          ? " · You texted STOP. Text START to resume."
                          : null}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(binding.id)}
                        size="sm"
                        variant="outline"
                      >
                        Disconnect
                      </Button>
                    </ItemActions>
                  </Item>
                </Fragment>
              );
            })}
          </PageRows>
        )}
      </PageSection>
      <PageSection
        description="In a Slack, Teams or Telegram chat that others can read, the Bot replies to you in a direct message."
        title="Connect a conversation"
      >
        {transports.data ? (
          <PageRows>
            {(Object.keys(TRANSPORT) as ConnectTransport[]).map(
              (transport, index) => {
                const Icon = TRANSPORT[transport].icon;
                const opens = open(transport);
                return (
                  <Fragment key={transport}>
                    {index > 0 ? <Separator /> : null}
                    <Item
                      render={
                        opens ? (
                          <button
                            onClick={() => setConnecting(transport)}
                            type="button"
                          />
                        ) : undefined
                      }
                      size="sm"
                    >
                      <ItemMedia variant="icon">
                        <Icon />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{TRANSPORT[transport].link}</ItemTitle>
                        <ItemDescription>{summary(transport)}</ItemDescription>
                      </ItemContent>
                      {opens ? (
                        <ItemActions>
                          <IconChevronRight className="size-4 text-muted-foreground" />
                        </ItemActions>
                      ) : null}
                    </Item>
                  </Fragment>
                );
              },
            )}
          </PageRows>
        ) : null}
      </PageSection>
      {connecting && transports.data ? (
        <ConnectDialog
          available={transports.data}
          botName={botName}
          challengeId={challengeId}
          fixedBot={fixedBot}
          linked={
            connecting === "telegram" || connecting === "sms"
              ? undefined
              : (heldLink(connecting) as HeldLink | undefined)
          }
          onChallenge={setChallengeId}
          onClose={() => setConnecting(null)}
          onLinked={(link) =>
            setLinks((prior) => ({ ...prior, [link.platform]: link }))
          }
          onTelegramLinked={setTelegramLink}
          telegramLinked={
            connecting === "telegram"
              ? (heldLink("telegram") as HeldTelegram | undefined)
              : undefined
          }
          transport={connecting}
        />
      ) : null}
    </>
  );
}

/**
 * Choose the conversation, then link an account, connect a Telegram bot, or verify a phone. Linking
 * an account answers with a one-time `link <code>` message to send to the OpenBot app; a Telegram
 * bot answers with the same kind of message for that bot; a phone answers with a text carrying a
 * code to type back here.
 */
function ConnectDialog({
  transport,
  available,
  fixedBot,
  botName,
  challengeId,
  linked,
  telegramLinked,
  onChallenge,
  onLinked,
  onTelegramLinked,
  onClose,
}: {
  transport: ConnectTransport;
  available: Transports;
  fixedBot: string | undefined;
  botName: (id: string) => string;
  challengeId: string;
  /** The link message this platform last answered with, while it still works. */
  linked: HeldLink | undefined;
  telegramLinked: HeldTelegram | undefined;
  onChallenge: (id: string) => void;
  onLinked: (link: HeldLink) => void;
  onTelegramLinked: (link: HeldTelegram) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const channels = useInfiniteQuery(channelListQueryOptions());
  // Reopened with a link message still held, the dialog shows the conversation it links.
  const prior = linked ?? telegramLinked;
  const [channelId, setChannelId] = useState(prior?.channelId ?? "");
  const [pickedBot, setAgentId] = useState(prior?.agentId ?? "");
  const agentId = fixedBot ?? pickedBot;
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [botToken, setBotToken] = useState("");
  const [copied, setCopied] = useState(false);
  const link = useMutation(startChatLinkMutationOptions());
  const sms = useMutation(startSmsMutationOptions());
  const telegram = useMutation(startTelegramMutationOptions());
  const confirm = useMutation(confirmSmsMutationOptions(queryClient));
  const startLink = (platform: ChatPlatform) =>
    link.mutate(
      { channelId, agentId, platform },
      {
        onSuccess: (result) => {
          onLinked({ ...result, channelId, agentId });
          setCopied(false);
        },
      },
    );
  const conversations =
    channels.data?.filter(
      (channel) =>
        channel.active &&
        (fixedBot === undefined || channel.agentIds.includes(fixedBot)),
    ) ?? [];
  const selected = channels.data?.find((channel) => channel.id === channelId);
  const chosen = !!agentId && !!channelId;
  const error =
    channels.error ??
    link.error ??
    sms.error ??
    telegram.error ??
    confirm.error;
  const pendingTelegram = telegramLinked;

  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TRANSPORT[transport].link}</DialogTitle>
          <DialogDescription>
            Each account, Telegram bot or phone number works with one
            conversation at a time. Linking it here moves it from the one it's
            linked to now.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-4 overflow-y-auto">
          <Field>
            <FieldLabel htmlFor={`${formId}-conversation`}>
              Conversation
            </FieldLabel>
            <Select
              items={Object.fromEntries(
                conversations.map((channel) => [
                  channel.id,
                  conversationLabel(channel),
                ]),
              )}
              onValueChange={(next) => {
                setChannelId(typeof next === "string" ? next : "");
                if (fixedBot === undefined) setAgentId("");
              }}
              value={channelId || null}
            >
              <SelectTrigger className="w-full" id={`${formId}-conversation`}>
                <SelectValue placeholder="Choose a conversation" />
              </SelectTrigger>
              <SelectContent>
                {conversations.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    {conversationLabel(channel)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {fixedBot === undefined ? (
            <Field>
              <FieldLabel htmlFor={`${formId}-bot`}>Bot</FieldLabel>
              <Select
                items={Object.fromEntries(
                  (selected?.agentIds ?? []).map((id) => [id, botName(id)]),
                )}
                onValueChange={(next) =>
                  setAgentId(typeof next === "string" ? next : "")
                }
                value={pickedBot || null}
              >
                <SelectTrigger className="w-full" id={`${formId}-bot`}>
                  <SelectValue placeholder="Choose a Bot" />
                </SelectTrigger>
                <SelectContent>
                  {selected?.agentIds.map((id) => (
                    <SelectItem key={id} value={id}>
                      {botName(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {channels.hasNextPage ? (
            <Button
              className="justify-self-start"
              onClick={() => channels.fetchNextPage()}
              size="sm"
              variant="outline"
            >
              Load more conversations
            </Button>
          ) : null}
          {transport === "sms" ? (
            <>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  sms.mutate(
                    { channelId, agentId, phone },
                    { onSuccess: onChallenge },
                  );
                }}
              >
                <Field>
                  <FieldLabel htmlFor={`${formId}-phone`}>
                    Phone number
                  </FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`${formId}-phone`}
                      onChange={(event) => setPhone(event.target.value)}
                      pattern="\+[1-9][0-9]{7,14}"
                      placeholder="+15551234567"
                      required
                      type="tel"
                      value={phone}
                    />
                    <Button
                      disabled={!chosen || !available.sms || sms.isPending}
                      size="sm"
                      type="submit"
                      variant={challengeId ? "outline" : "default"}
                    >
                      Send verification code
                    </Button>
                  </div>
                </Field>
              </form>
              {challengeId ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    confirm.mutate(
                      { challengeId, code },
                      {
                        onSuccess: () => {
                          onChallenge("");
                          setCode("");
                          onClose();
                        },
                      },
                    );
                  }}
                >
                  <Field>
                    <FieldLabel htmlFor={`${formId}-code`}>
                      Verification code
                    </FieldLabel>
                    <div className="flex items-center gap-2">
                      <Input
                        autoComplete="one-time-code"
                        id={`${formId}-code`}
                        onChange={(event) => setCode(event.target.value)}
                        required
                        value={code}
                      />
                      <Button
                        disabled={confirm.isPending}
                        size="sm"
                        type="submit"
                      >
                        Confirm phone
                      </Button>
                    </div>
                  </Field>
                </form>
              ) : null}
            </>
          ) : transport === "telegram" ? (
            pendingTelegram ? (
              <Item size="sm" variant="muted">
                <ItemContent>
                  <ItemDescription className="line-clamp-none">
                    Send this message to @{pendingTelegram.botUsername} in a
                    direct message in Telegram within{" "}
                    {Math.ceil(
                      (pendingTelegram.expiresAt - Date.now()) / 60_000,
                    )}{" "}
                    minutes. Only that chat is allow-listed for this
                    conversation and Bot.
                  </ItemDescription>
                  <ItemTitle className="break-all font-mono">
                    {pendingTelegram.command}
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    onClick={async () => {
                      await navigator.clipboard.writeText(
                        pendingTelegram.command,
                      );
                      setCopied(true);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </ItemActions>
              </Item>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  telegram.mutate(
                    { channelId, agentId, botToken },
                    {
                      onSuccess: (result) => {
                        onTelegramLinked({ ...result, channelId, agentId });
                        setBotToken("");
                        setCopied(false);
                      },
                    },
                  );
                }}
              >
                <Field>
                  <FieldLabel htmlFor={`${formId}-token`}>Bot token</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      autoComplete="off"
                      id={`${formId}-token`}
                      onChange={(event) => setBotToken(event.target.value)}
                      placeholder="123456789:AAH…"
                      required
                      spellCheck={false}
                      type="password"
                      value={botToken}
                    />
                    <Button
                      disabled={
                        !chosen ||
                        !available.telegram ||
                        telegram.isPending ||
                        !botToken
                      }
                      size="sm"
                      type="submit"
                    >
                      Connect Telegram
                    </Button>
                  </div>
                  <p className="mt-2 text-muted-foreground text-xs">
                    From BotFather. OpenBot keeps it encrypted and never shows
                    it again. Only the chat that sends the link code can talk to
                    this Bot.
                  </p>
                </Field>
              </form>
            )
          ) : linked ? (
            <Item size="sm" variant="muted">
              <ItemContent>
                <ItemDescription className="line-clamp-none">
                  Send this message to the OpenBot app in a direct message in{" "}
                  {linked.platform === "teams" ? "Microsoft Teams" : "Slack"}{" "}
                  within {Math.ceil((linked.expiresAt - Date.now()) / 60_000)}{" "}
                  minutes. It links that account to this conversation and Bot.
                </ItemDescription>
                <ItemTitle className="break-all font-mono">
                  {linked.command}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Button
                  onClick={async () => {
                    await navigator.clipboard.writeText(linked.command);
                    setCopied(true);
                  }}
                  size="sm"
                  variant="outline"
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </ItemActions>
            </Item>
          ) : null}
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {failureSaid(error)}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            Close
          </Button>
          {/* A phone's and Telegram's steps each submit their own field. */}
          {transport === "sms" || transport === "telegram" ? null : (
            <Button
              disabled={!chosen || !available[transport] || link.isPending}
              onClick={() => startLink(transport)}
              size="sm"
            >
              {TRANSPORT[transport].link}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
