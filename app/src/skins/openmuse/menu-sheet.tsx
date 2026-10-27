import {
  IconBell,
  IconBolt,
  IconBox,
  IconBrain,
  IconCalendarRepeat,
  IconHandStop,
  IconHome,
  IconLogout,
  IconMessageCircle,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconPlug,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShieldLock,
  IconTargetArrow,
  IconTrash,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  isUnread,
  matchingChannels,
  pinnedFirst,
} from "@/components/app-sidebar/app-sidebar";
import { ChannelPagination } from "@/components/app-sidebar/channel-pagination";
import { ChannelAvatar } from "@/components/channels/avatar";
import { DeleteConversationDialog } from "@/components/channels/delete-conversation-dialog";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setChannelPinnedMutationOptions } from "@/lib/channels/mutations";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { appConfig } from "@/lib/generated/application-config";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { useMuse } from "./context";
import { MainChatLink, NewChatLink } from "./links";
import {
  Divider,
  ErrorNotice,
  LinkRow,
  MuseButton,
  MuseLinkButton,
  MuseSheet,
  museText,
} from "./ui";

/**
 * OpenMuse's menu: the main chat, a new chat, every conversation OpenBot keeps, and a way to every
 * other OpenBot surface. Nothing here is OpenMuse's own data; each row opens an OpenBot route.
 */
export function MenuSheet({ onClose }: { onClose: () => void }) {
  const { bot } = useMuse();
  const user = useQuery(currentUserQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [search, setSearch] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const searching = search.trim().length > 0;
  const shown = pinnedFirst(matchingChannels(channels.data, search));
  const botName = bot?.name ?? "your Bot";

  return (
    <MuseSheet
      bodyRef={body}
      onClose={onClose}
      subtitle={user.data?.name || user.data?.email}
      title={appConfig.brand.productName}
    >
      <div className="flex flex-col gap-3.5">
        <LinkRow
          detail={`Your ongoing conversation with ${botName}`}
          icon={IconMessageCircle}
          render={<MainChatLink agentId={bot?.id} onClick={onClose} />}
          title="Main chat"
        />
        <MuseLinkButton
          icon={IconPlus}
          primary
          render={<NewChatLink agentId={bot?.id} onClick={onClose} />}
        >
          New chat
        </MuseLinkButton>
        <div className="mt-3 flex items-center justify-between">
          <h2 className={museText.heading}>Conversations</h2>
          <MuseLinkButton
            icon={IconUsersGroup}
            render={<Link onClick={onClose} to="/channel/new" />}
            small
          >
            Group chat
          </MuseLinkButton>
        </div>
        <label className="relative block">
          <IconSearch
            aria-hidden="true"
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-4 size-4 text-muted-foreground"
          />
          <input
            aria-label="Search conversations"
            className="min-h-[45px] w-full rounded-[19px] border border-border bg-card py-3 pr-4 pl-10 text-[16px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-[var(--openmuse-focus)]"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            value={search}
          />
        </label>
        {channels.isPending ? null : channels.error ? (
          <ErrorNotice error="Couldn't load your conversations." />
        ) : shown.length === 0 ? (
          <p className={museText.muted}>
            {searching
              ? `No conversation has “${search.trim()}” in its name or latest message.`
              : `Start a conversation with ${botName} and it shows up here.`}
          </p>
        ) : (
          <div>
            {shown.map((channel) => (
              <ConversationRow
                channel={channel}
                key={channel.id}
                onOpen={onClose}
              />
            ))}
          </div>
        )}
        <ChannelPagination
          query={channels}
          scrollRoot={body}
          searching={searching}
        />
        <p className={museText.small}>
          A conversation stays with the Bots in it. Pin one to keep it at the
          top.
        </p>
        <Divider className="my-1.5" />
        <div>
          <LinkRow
            detail="Start a conversation with any Bot"
            icon={IconHome}
            render={<Link onClick={onClose} to="/" />}
            title="Home"
          />
          <LinkRow
            detail="Yours, shared with you, and your team's"
            icon={IconBolt}
            render={<Link onClick={onClose} to="/bots" />}
            title="Bots"
          />
          {bot ? (
            <LinkRow
              detail={`What ${bot.name} keeps doing for you`}
              icon={IconTargetArrow}
              render={
                <Link
                  onClick={onClose}
                  params={{ agentId: bot.id }}
                  to="/bots/$agentId/responsibilities"
                />
              }
              tint="green"
              title="Responsibilities"
            />
          ) : null}
          <LinkRow
            detail="What your Bots do on a schedule"
            icon={IconCalendarRepeat}
            render={<Link onClick={onClose} to="/routines" />}
            tint="green"
            title="Routines"
          />
          <LinkRow
            detail="What your Bots know how to do"
            icon={IconBox}
            render={<Link onClick={onClose} to="/capabilities/skills" />}
            tint="lavender"
            title="Skills"
          />
          <LinkRow
            detail="What your Bots remember about you"
            icon={IconBrain}
            render={<Link onClick={onClose} to="/capabilities/memory" />}
            tint="lavender"
            title="Memory"
          />
          <LinkRow
            detail="The accounts your Bots use as you"
            icon={IconPlug}
            render={<Link onClick={onClose} to="/connections" />}
            tint="orange"
            title="Connections"
          />
          <LinkRow
            detail="What your Bots ask you before they act"
            icon={IconHandStop}
            render={<Link onClick={onClose} to="/settings/approvals" />}
            tint="orange"
            title="Approvals"
          />
          <LinkRow
            detail="Where your Bots reach you"
            icon={IconBell}
            render={<Link onClick={onClose} to="/settings/notifications" />}
            tint="orange"
            title="Reachability"
          />
          <LinkRow
            detail="Theme, skin and preferences"
            icon={IconSettings}
            render={<Link onClick={onClose} to="/settings" />}
            tint="plain"
            title="Settings"
          />
          {user.data?.role === "admin" ? (
            <LinkRow
              detail="People, Bots and policy for everyone here"
              icon={IconShieldLock}
              render={<Link onClick={onClose} to="/admin" />}
              tint="plain"
              title="Admin"
            />
          ) : null}
        </div>
        <MuseButton
          className="self-start"
          danger
          disabled={signOut.isPending}
          icon={IconLogout}
          onClick={async () => {
            await signOut.mutateAsync();
            await navigate({ to: "/sign" });
          }}
          small
        >
          Sign out
        </MuseButton>
        <ErrorNotice error={signOut.error?.message} />
      </div>
    </MuseSheet>
  );
}

/**
 * One conversation, laid out as this look lists a side chat: its Bots' faces and title, then its actions as pills.
 * Pin and delete are the same two OpenBot offers on its sidebar row.
 */
function ConversationRow({
  channel,
  onOpen,
}: {
  channel: ChannelSummary;
  onOpen: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const navigate = useNavigate();
  const openId = useParams({
    strict: false,
    select: (params) => (params as { channelId?: string }).channelId,
  });
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  const group = channel.agentIds.length > 1;
  const unread = isUnread(channel, openId);
  const busy = channel.busy || (channel.work?.length ?? 0) > 0;
  const title =
    channel.summary?.trim() ||
    channel.lastMessage?.trim() ||
    "New conversation";
  const who = group
    ? channel.agentIds
        .map((id) => agents.data?.find((agent) => agent.id === id)?.name)
        .filter(Boolean)
        .join(", ") || channel.name
    : channel.name;
  const when = channel.lastMessageAt ? relativeTime(channel.lastMessageAt) : "";

  return (
    <div className="flex flex-col gap-2.5 border-border border-b py-3">
      <Item
        className={cn(
          "flex-nowrap items-start gap-2.5 border-0 p-0 [a]:hover:bg-transparent",
          channel.id === openId && "[&_[data-slot=item-title]]:underline",
        )}
        render={
          <Link
            onClick={onOpen}
            params={{ channelId: channel.id }}
            to={group ? "/group/$channelId" : "/channel/$channelId"}
          />
        }
      >
        {/* The same faces OpenBot's own conversation list draws: the Bot, or the group's Bots. */}
        <span className="mt-0.5 shrink-0">
          <ChannelAvatar
            participantIds={channel.agentIds}
            size={24}
            typing={busy}
          />
        </span>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle
            className={cn(
              museText.body,
              "line-clamp-1 block",
              unread && "font-semibold",
            )}
          >
            {title}
          </ItemTitle>
          <span className={cn(museText.small, "flex items-center gap-1.5")}>
            <span className="truncate">
              {who}
              {when ? ` · ${when}` : ""}
            </span>
            {busy ? (
              <span className="shrink-0 text-[var(--openmuse-accent)]">
                · working
              </span>
            ) : null}
          </span>
        </ItemContent>
        {unread ? (
          <span
            className="mt-2 size-2 shrink-0 rounded-full bg-[var(--openmuse-accent)]"
            role="img"
            aria-label="Unread"
          />
        ) : null}
        {channel.pinned ? (
          <IconPinFilled
            aria-label="Pinned"
            className="mt-1 size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
      </Item>
      <div className="flex gap-2">
        <MuseButton
          disabled={setPinned.isPending}
          icon={channel.pinned ? IconPinnedOff : IconPin}
          onClick={() =>
            setPinned.mutate({ channelId: channel.id, pinned: !channel.pinned })
          }
          small
        >
          {channel.pinned ? "Unpin" : "Pin"}
        </MuseButton>
        <MuseButton icon={IconTrash} onClick={() => setConfirming(true)} small>
          Delete
        </MuseButton>
      </div>
      <ErrorNotice error={setPinned.error?.message} />
      <DeleteConversationDialog
        channelId={channel.id}
        leave={channel.id === openId ? () => navigate({ to: "/" }) : undefined}
        name={channel.name}
        onOpenChange={setConfirming}
        open={confirming}
      />
    </div>
  );
}
