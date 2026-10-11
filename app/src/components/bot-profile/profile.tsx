import {
  IconBell,
  IconChevronRight,
  IconMessage,
  IconPlayerPause,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { BotNeedsYou } from "@/components/approvals/waiting";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { SuggestionsInbox } from "@/components/suggestions/proactive-panel";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type BotNotify,
  botLifecycleQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";
import { BotActivitySections } from "./activity";
import { BotPausedBanner } from "./pause-banner";

const NOTIFY_LABEL: Record<BotNotify, string> = {
  all: "Everything",
  needs_input: "Only when it needs me",
  none: "Nothing (badges only)",
};

/** A Bot's own page: its state for you, what it is doing, its settings, and what can be done to it. */
export function BotProfile({
  agent,
  settings,
  manage,
}: {
  agent: AgentProfile;
  /** The "Settings for this Bot" card. */
  settings?: React.ReactNode;
  /** Pin, hide, duplicate, reset, delete. */
  manage?: React.ReactNode;
}) {
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const pause = useMutation(setBotPausedMutationOptions(queryClient));
  const notify = useMutation(setBotNotifyMutationOptions(queryClient));
  const [permission, setPermission] = useState<string>(() => {
    try {
      return typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission;
    } catch {
      return "unsupported";
    }
  });

  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={40} />
        <div className="min-w-0">
          <p className="truncate font-medium">{agent.title}</p>
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {agent.roleDescription}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <BotPausedBanner agentId={agent.id} />
      </div>

      <BotNeedsYou agentId={agent.id} />
      <SuggestionsInbox agentId={agent.id} />

      <PageSection title="For you">
        {/* Whether this Bot's Shared-app calls are being refused right now, with the button that
            asks an administrator. About its present reach, so it lives here, not only where
            publishing happens. */}
        {agent.canManage ? (
          <SharedAppNotice botId={agent.id} reason="publish" />
        ) : null}
        {lifecycle.isPending ? null : lifecycle.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load this Bot's state.
          </p>
        ) : (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPlayerPause />
              </ItemMedia>
              <ItemContent>
                {/* On means working, the way a responsibility's Active switch reads: titled "Paused",
                    the row showed the word "Paused" beside a switch that was off for a running Bot. */}
                <ItemTitle>Active</ItemTitle>
                <ItemDescription>
                  {lifecycle.data.paused
                    ? "Paused. No routine, responsibility, hand-off or follow-up starts for you, and what was running has stopped."
                    : "Runs its routines, responsibilities, hand-offs and follow-ups for you."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label="Active"
                  checked={!lifecycle.data.paused}
                  disabled={pause.isPending}
                  onCheckedChange={(active) =>
                    pause.mutate({ agentId: agent.id, paused: !active })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBell />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Notifications</ItemTitle>
                <ItemDescription>
                  {NOTIFY_LABEL[lifecycle.data.notify]}. Sidebar badges always
                  show.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Select
                  disabled={notify.isPending}
                  // The label map, so the closed trigger says "Everything" rather than the raw value.
                  items={NOTIFY_LABEL}
                  onValueChange={(next) => {
                    if (next === lifecycle.data.notify) return;
                    notify.mutate({
                      agentId: agent.id,
                      notify: next as BotNotify,
                    });
                  }}
                  value={lifecycle.data.notify}
                >
                  <SelectTrigger aria-label="Notifications">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(NOTIFY_LABEL) as BotNotify[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {NOTIFY_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ItemActions>
            </Item>
            {permission === "default" ? (
              <>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconBell />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>Browser notifications</ItemTitle>
                    <ItemDescription>
                      Off in this browser. Turn them on to hear when a Bot needs
                      you.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={async () => {
                        try {
                          setPermission(await Notification.requestPermission());
                        } catch {
                          setPermission("unsupported");
                        }
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Turn on
                    </Button>
                  </ItemActions>
                </Item>
              </>
            ) : null}
            <Separator />
            <Item
              render={<Link to="/channel/new" search={{ agent: agent.id }} />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconMessage />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Message {agent.name}</ItemTitle>
                <ItemDescription>Start a conversation.</ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          </PageRows>
        )}
      </PageSection>

      <BotActivitySections agentId={agent.id} />
      {settings}
      {manage}
    </>
  );
}
