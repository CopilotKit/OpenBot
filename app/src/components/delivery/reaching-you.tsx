import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { conversationLabel } from "@/lib/channels/label";
import { channelListQueryOptions } from "@/lib/channels/queries";
import {
  confirmSms,
  deliveryKey,
  deliveryQueryOptions,
  removeDeliveryBinding,
  startChatLink,
  startSms,
} from "@/lib/delivery";
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

/**
 * Continuing a conversation in Slack, Microsoft Teams or by text message. Given a Bot, only that
 * Bot's conversations and destinations, and no Bot to pick.
 */
export function ReachingYou({ agentId: fixedBot }: { agentId?: string }) {
  const reach = useQuery(deliveryQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  // People read Bots by name; the id is what the list used to show.
  const botName = (id: string) =>
    bots.data?.find((bot) => bot.id === id)?.name ?? id;
  const [channelId, setChannelId] = useState("");
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
  const [phone, setPhone] = useState("");
  const [copied, setCopied] = useState(false);
  const [challengeId, setChallengeId] = useState(readPending);
  useEffect(() => writePending(challengeId), [challengeId]);
  const [code, setCode] = useState("");
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: deliveryKey });
  const link = useMutation({
    mutationFn: (platform: "slack" | "teams") =>
      startChatLink({ channelId, agentId, platform }),
    onSuccess: () => setCopied(false),
  });
  const sms = useMutation({
    mutationFn: () => startSms({ channelId, agentId, phone }),
    onSuccess: setChallengeId,
  });
  const confirm = useMutation({
    mutationFn: () => confirmSms(challengeId, code),
    onSuccess: async () => {
      setChallengeId("");
      setCode("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: removeDeliveryBinding,
    onSuccess: refresh,
  });
  const selected = channels.data?.find((channel) => channel.id === channelId);
  const error =
    reach.error ??
    channels.error ??
    link.error ??
    sms.error ??
    confirm.error ??
    remove.error;
  return (
    <div className="grid gap-5">
      {fixedBot === undefined ? (
        <p className="text-muted-foreground text-sm">
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
      {error && (
        <p role="alert" className="text-destructive">
          {error.message}
        </p>
      )}
      <div className="grid gap-3 rounded-lg border p-4">
        <h2 className="font-semibold">Connect a conversation</h2>
        <label className="grid gap-1 text-sm">
          Conversation
          <select
            className="h-9 rounded border bg-background px-3"
            value={channelId}
            onChange={(event) => {
              setChannelId(event.target.value);
              if (fixedBot === undefined) setAgentId("");
            }}
          >
            <option value="">Choose a conversation</option>
            {channels.data
              ?.filter(
                (channel) =>
                  channel.active &&
                  (fixedBot === undefined ||
                    channel.agentIds.includes(fixedBot)),
              )
              .map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {conversationLabel(channel)}
                </option>
              ))}
          </select>
        </label>
        {fixedBot === undefined ? (
          <label className="grid gap-1 text-sm">
            Bot
            <select
              className="h-9 rounded border bg-background px-3"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              <option value="">Choose a Bot</option>
              {selected?.agentIds.map((id) => (
                <option key={id} value={id}>
                  {botName(id)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {channels.hasNextPage && (
          <Button variant="outline" onClick={() => channels.fetchNextPage()}>
            Load more conversations
          </Button>
        )}
        <p className="text-muted-foreground text-sm">
          An account or phone number reaches one conversation at a time. Linking
          it here moves it from wherever it is linked now.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              !agentId ||
              !channelId ||
              !reach.data?.available.slack ||
              link.isPending
            }
            onClick={() => link.mutate("slack")}
          >
            Link Slack
          </Button>
          <Button
            variant="outline"
            disabled={
              !agentId ||
              !channelId ||
              !reach.data?.available.teams ||
              link.isPending
            }
            onClick={() => link.mutate("teams")}
          >
            Link Microsoft Teams
          </Button>
        </div>
        {link.data && (
          <div className="grid gap-2 rounded border bg-muted/40 p-3 text-sm">
            <p>
              Send this message to the OpenBot app in{" "}
              {link.data.platform === "teams" ? "Microsoft Teams" : "Slack"}{" "}
              within {link.data.expiresInMinutes} minutes. It links that account
              to this conversation and Bot.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1">
                {link.data.command}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(link.data?.command ?? "");
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          In a channel other people can read, the Bot answers you in a direct
          message instead.
        </p>
        {reach.data && !reach.data.available.slack && (
          <p className="text-sm text-muted-foreground">
            An administrator needs to pair OpenBot with OpenTag before Slack or
            Teams can be linked.
          </p>
        )}
        <form
          className="grid gap-3 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            sms.mutate();
          }}
        >
          <label htmlFor="delivery-phone" className="grid gap-1 text-sm">
            Phone number
            <Input
              id="delivery-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+15551234567"
              required
              pattern="\+[1-9][0-9]{7,14}"
            />
          </label>
          <Button
            type="submit"
            disabled={
              !agentId ||
              !channelId ||
              !reach.data?.available.sms ||
              sms.isPending
            }
          >
            Send verification code
          </Button>
        </form>
        {challengeId && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              confirm.mutate();
            }}
          >
            <Input
              aria-label="Verification code"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
            <Button type="submit" disabled={confirm.isPending}>
              Confirm phone
            </Button>
          </form>
        )}
      </div>
      <section className="grid gap-3 rounded-lg border p-4">
        <h2 className="font-semibold">Connected destinations</h2>
        {reach.isPending ? (
          <p>Loading connections…</p>
        ) : (
          reach.data?.bindings
            .filter(
              (binding) =>
                binding.enabled &&
                (fixedBot === undefined || binding.agentId === fixedBot),
            )
            .map((binding) => (
              <div
                key={binding.id}
                className="flex items-center justify-between gap-2"
              >
                <p className="text-sm">
                  {binding.transport === "slack"
                    ? "Slack"
                    : binding.transport === "teams"
                      ? "Microsoft Teams"
                      : binding.optedOutAt
                        ? `${binding.address} (replied STOP; text START to resume)`
                        : binding.address}{" "}
                  · {botName(binding.agentId)}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(binding.id)}
                >
                  Disconnect
                </Button>
              </div>
            ))
        )}
        {reach.data?.bindings.every(
          (binding) =>
            !binding.enabled ||
            (fixedBot !== undefined && binding.agentId !== fixedBot),
        ) && (
          <p className="text-sm text-muted-foreground">
            No destinations connected.
          </p>
        )}
      </section>
    </div>
  );
}
