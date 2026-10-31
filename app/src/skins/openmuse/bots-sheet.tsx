import {
  IconBolt,
  IconCheck,
  IconPlus,
  IconUserCircle,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";
import { chooseBot } from "./chosen-bot";
import { useMuse } from "./context";
import { mainChannel, tabFor } from "./model";
import { Divider, ErrorNotice, LinkRow, MuseSheet, museText } from "./ui";

/**
 * Who sits at the centre of the frame. This look has one agent; OpenBot has a roster, so this is the
 * one place the difference shows, and it stays a sheet behind the name rather than a fixture.
 */
export function BotsSheet({ onClose }: { onClose: () => void }) {
  const { bot: centre, userId } = useMuse();
  const agents = useQuery(agentListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const navigate = useNavigate();

  const choose = (agentId: string) => {
    if (userId) chooseBot(userId, agentId);
    onClose();
    // On Chat, choosing a Bot means talking to it; elsewhere the tab stays and follows the Bot.
    if (tabFor(pathname) !== "chat") return;
    const main = mainChannel(agentId, channels.data);
    void (main
      ? navigate({ to: "/channel/$channelId", params: { channelId: main.id } })
      : navigate({ to: "/channel/new", search: { agent: agentId } }));
  };

  return (
    <MuseSheet
      onClose={onClose}
      subtitle={`Choose who is at the centre of ${appConfig.brand.productName}.`}
      title="Your Bots"
    >
      <div className="flex flex-col gap-3.5">
        {agents.isPending ? null : agents.error ? (
          <ErrorNotice error="Couldn't load your Bots. Reload the page." />
        ) : agents.data.length === 0 ? (
          <p className={museText.muted}>You don't have a Bot yet.</p>
        ) : (
          <div className="flex flex-col">
            {agents.data.map((agent) => {
              const waiting = attention.data?.find(
                (entry) => entry.agentId === agent.id,
              );
              const asks = waiting ? needsInput(waiting) : 0;
              const summary = waiting ? attentionSummary(waiting) : "";
              const selected = agent.id === centre?.id;
              return (
                <Item
                  aria-pressed={selected}
                  className={cn(
                    "flex-nowrap gap-3.5 rounded-[18px] border-0 px-2 py-2 text-left hover:bg-[var(--openmuse-pressed)]",
                    selected &&
                      "bg-[var(--openmuse-sky)] hover:bg-[var(--openmuse-sky)]",
                  )}
                  key={agent.id}
                  render={
                    <button onClick={() => choose(agent.id)} type="button" />
                  }
                >
                  <AbstractAvatar
                    name={agent.name}
                    seed={agent.avatarSeed}
                    size={44}
                  />
                  <ItemContent className="min-w-0 gap-0.5">
                    <ItemTitle className={cn(museText.body, "font-medium")}>
                      {agent.name}
                    </ItemTitle>
                    <span className={cn(museText.small, "line-clamp-1")}>
                      {asks
                        ? `Needs you · ${summary}`
                        : summary || agent.title || agent.roleDescription}
                    </span>
                  </ItemContent>
                  {selected ? (
                    <IconCheck
                      aria-hidden="true"
                      className="size-[18px] shrink-0 text-[var(--openmuse-accent)]"
                    />
                  ) : summary ? (
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-[var(--openmuse-accent)]"
                    />
                  ) : null}
                </Item>
              );
            })}
          </div>
        )}
        <Divider className="my-1" />
        <div>
          {centre ? (
            <LinkRow
              detail="Setup, access, sharing and activity"
              icon={IconUserCircle}
              render={
                <Link
                  onClick={onClose}
                  params={{ agentId: centre.id }}
                  to="/bots/$agentId"
                />
              }
              title={`${centre.name}'s page`}
            />
          ) : null}
          <LinkRow
            detail="Yours, shared with you, and your team's"
            icon={IconBolt}
            render={<Link onClick={onClose} to="/bots" />}
            tint="plain"
            title="All Bots"
          />
          <LinkRow
            detail="Describe what it should do"
            icon={IconPlus}
            render={
              <Link onClick={onClose} search={{ new: true }} to="/bots" />
            }
            tint="plain"
            title="New Bot"
          />
        </div>
      </div>
    </MuseSheet>
  );
}
