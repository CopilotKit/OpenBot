import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotPausedBanner } from "@/components/bot-profile/pause-banner";
import { ChannelAvatar } from "@/components/channels/avatar";
import { GroupChat } from "@/components/channels/group-chat";
import { GroupPeopleButton } from "@/components/channels/group-people";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { useMarkOpenChannelRead } from "@/lib/channels/mark-read";
import { channelQueryOptions } from "@/lib/channels/queries";

/** A conversation with several Bots. The channel is an ordinary channel with more than one Bot. */
export const Route = createFileRoute("/_authed/_app/group/$channelId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { channelId } = Route.useParams();
  const channel = useQuery(channelQueryOptions(channelId));
  useMarkOpenChannelRead(channelId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 flex min-h-12 flex-row items-center gap-1.5 border-b border-border px-3 py-2">
        <SidebarToggle />
        <ChannelAvatar
          participantIds={channel.data?.agentIds ?? []}
          size={22}
        />
        <span className="min-w-0 truncate text-sm tracking-tight">
          {channel.data?.name ?? "Group"}
        </span>
        <GroupPeopleButton channelId={channelId} />
      </div>
      {(channel.data?.agentIds ?? []).map((agentId) => (
        <BotPausedBanner agentId={agentId} key={agentId} />
      ))}
      {/* Remounted per channel so one group's transcript never flashes in another. */}
      <GroupChat channelId={channelId} key={channelId} />
    </div>
  );
}
