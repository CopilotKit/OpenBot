import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { ActivityRow, upcomingOf } from "@/components/bot-profile/activity";
import { useWaitingOnYou } from "@/components/bot-profile/attention";
import { Button } from "@/components/ui/button";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { groupRoster } from "@/lib/agents/roster";
import { botActivityQueryOptions } from "@/lib/bot-lifecycle/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { cn } from "@/lib/utils";
import {
  PlaceEmpty,
  type PlaceEntry,
  PlaceHeading,
  PlaceRow,
} from "./place-row";

function BotsPlace() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const agents = useQuery(agentListQueryOptions());
  const waiting = useWaitingOnYou();
  const channels = useInfiniteQuery(channelListQueryOptions());
  const { needsYou, pinned, yours, shared } = groupRoster(
    agents.data ?? [],
    (id) => waiting(id),
  );
  const working = new Set(
    (channels.data ?? [])
      .filter((channel) => channel.busy || (channel.work?.length ?? 0) > 0)
      .flatMap((channel) => channel.agentIds),
  );
  if (agents.isPending) return null;
  if (agents.error) {
    return (
      <p className="px-2 py-3 text-muted-foreground text-xs" role="alert">
        Couldn't load your Bots. Try again in a moment.
      </p>
    );
  }
  const sections = [
    { title: "Needs you", bots: needsYou },
    { title: "Pinned", bots: pinned },
    { title: "Yours", bots: yours },
    {
      title: personal ? "Included with OpenBot" : "Shared with you",
      bots: shared,
    },
  ];

  return (
    <div className="flex flex-col pb-2">
      {sections.map((section) =>
        section.bots.length ? (
          <section key={section.title}>
            <PlaceHeading>{section.title}</PlaceHeading>
            {section.bots.map((agent) => (
              <BotItem
                agent={agent}
                key={agent.id}
                waiting={waiting(agent.id)}
                working={working.has(agent.id)}
              />
            ))}
          </section>
        ) : null,
      )}
    </div>
  );
}

function BotItem({
  agent,
  waiting,
  working,
}: {
  agent: AgentProfile;
  waiting: number;
  working: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center">
        <PlaceRow
          className="flex-1"
          media={<BotOrb name={agent.name} seed={agent.avatarSeed} size={20} />}
          title={agent.name}
          to={{ to: "/bots/$agentId", params: { agentId: agent.id } }}
          trailing={
            waiting > 0 || working ? (
              <span className="flex items-center gap-2">
                {waiting > 0 ? (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {waiting}
                  </span>
                ) : null}
                {working ? (
                  <span
                    aria-label="Working"
                    className="size-1.5 rounded-full bg-indigo-500"
                    role="img"
                  />
                ) : null}
              </span>
            ) : null
          }
        />
        <Button
          aria-expanded={open}
          aria-label={`What ${agent.name} is doing`}
          onClick={() => setOpen(!open)}
          size="icon-sm"
          variant="ghost"
        >
          <IconChevronRight
            className={cn("transition-transform", open && "rotate-90")}
          />
        </Button>
      </div>
      {open ? <BotUpcoming agentId={agent.id} /> : null}
    </div>
  );
}

/** Read only for an open row, so a long list of Bots does not read every Bot's activity. */
function BotUpcoming({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  const upcoming = upcomingOf(activity.data);
  if (activity.isPending) return null;
  if (activity.error) {
    return (
      <p className="px-2 py-3 text-muted-foreground text-xs" role="alert">
        Couldn't load what it is doing. Try again in a moment.
      </p>
    );
  }
  if (upcoming.length === 0) {
    return <PlaceEmpty>Nothing under way or lined up.</PlaceEmpty>;
  }
  return (
    <div className="flex flex-col pl-4">
      {upcoming.map(({ item, live }) => (
        <ActivityRow agentId={agentId} item={item} key={item.id} live={live} />
      ))}
    </div>
  );
}

function NewBotAction() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Button
        aria-label="New Bot"
        onClick={() => setOpen(true)}
        size="icon-sm"
        variant="ghost"
      >
        <IconPlus />
      </Button>
      <NewBotSheet
        onClose={() => setOpen(false)}
        onCreated={(id) => {
          setOpen(false);
          void navigate({ to: "/bots/$agentId", params: { agentId: id } });
        }}
        open={open}
      />
    </>
  );
}

export const botsPlace: PlaceEntry = { List: BotsPlace, Action: NewBotAction };
