import {
  IconBox,
  IconChecklist,
  IconDotsVertical,
  IconMessages,
  IconPlus,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SolidFace } from "@/components/agents/solid-face";
import { ChannelAvatar } from "@/components/channels/avatar";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { useSidebar } from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { approvalInboxOptions } from "@/lib/approvals";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { waitingCount } from "../openduet/tasks-model";
import { useLatchMenu } from "./context";

/** How many Bots the shortcut grid shows before the Add tile: two rows of four, less one. */
const SHORTCUTS = 7;
/** How many recent conversations the row shows. */
const RECENTS = 8;

/**
 * The bar above the message box on a phone, as Latch's home has it: Capabilities on the left
 * (Latch's extensions button), then the number of conversations (Latch's tab count, which opens
 * the list) and ⋮ (the menu) on the right. On a computer, OpenBot's own bar.
 */
export function LatchHomeTop() {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const { openMenu } = useLatchMenu();
  const channels = useInfiniteQuery(channelListQueryOptions());
  if (!isMobile) return <SidebarToggleBar />;
  const count = channels.data?.length ?? 0;

  return (
    <div data-slot="latch-home-top">
      <Link
        aria-label="Capabilities"
        data-slot="latch-top-button"
        to="/capabilities"
      >
        <IconBox />
      </Link>
      <span className="flex-1" />
      <button
        aria-label={`Conversations, ${count}`}
        data-slot="latch-top-button"
        onClick={() => setOpenMobile(true)}
        type="button"
      >
        <span data-slot="latch-count">{count > 99 ? "99+" : count}</span>
      </button>
      <button
        aria-label="Menu"
        data-slot="latch-top-button"
        onClick={openMenu}
        type="button"
      >
        <IconDotsVertical />
      </button>
    </div>
  );
}

/**
 * Under the message box on a phone: your Bots as round shortcuts with an Add tile, your recent
 * conversations as a row of faces, and a card saying what waits on you, as Latch's home has its
 * shortcuts, Recently Visited and shield card.
 */
export function LatchHomeBelow() {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const inbox = useQuery(approvalInboxOptions());
  if (!isMobile) return null;

  const bots = agents.data?.slice(0, SHORTCUTS) ?? [];
  const recents = channels.data?.slice(0, RECENTS) ?? [];
  const waiting = waitingCount(inbox.data);
  const busy = channels.data?.filter((channel) => channel.busy).length ?? 0;

  return (
    <div data-slot="latch-home">
      <ul aria-label="Your Bots" data-slot="latch-shortcuts">
        {bots.map((agent) => (
          <li key={agent.id}>
            <Link
              data-slot="latch-shortcut"
              search={{ agent: agent.id }}
              to="/channel/new"
            >
              <span data-slot="latch-shortcut-face">
                <SolidFace
                  name={agent.name}
                  seed={agent.avatarSeed}
                  size={52}
                />
              </span>
              <span data-slot="latch-shortcut-label">{agent.name}</span>
            </Link>
          </li>
        ))}
        <li>
          <Link data-slot="latch-shortcut" to="/bots">
            <span data-slot="latch-shortcut-face">
              <IconPlus />
            </span>
            <span data-slot="latch-shortcut-label">Add</span>
          </Link>
        </li>
      </ul>

      {recents.length ? (
        <section aria-labelledby="latch-recent">
          <div data-slot="latch-home-head">
            <h2 id="latch-recent">Recent chats</h2>
            <button onClick={() => setOpenMobile(true)} type="button">
              See all
            </button>
          </div>
          <ul data-slot="latch-recents">
            {recents.map((channel) => (
              <li key={channel.id}>
                <Link
                  aria-label={channel.summary ?? channel.name}
                  data-slot="latch-recent"
                  to={
                    channel.agentIds.length > 1
                      ? "/group/$channelId"
                      : "/channel/$channelId"
                  }
                  params={{ channelId: channel.id }}
                >
                  <ChannelAvatar
                    participantIds={channel.agentIds}
                    size={44}
                    typing={channel.busy}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="latch-status" data-slot="latch-status">
        <div data-slot="latch-status-head">
          <span id="latch-status">
            <IconChecklist />
            Your Bots
          </span>
          <Link to="/approvals">View →</Link>
        </div>
        <div data-slot="latch-status-stats">
          <div>
            <IconChecklist />
            <span>
              <strong>{waiting}</strong>
              <span>Waiting on you</span>
            </span>
          </div>
          <div>
            <IconMessages />
            <span>
              <strong>{busy}</strong>
              <span>Working now</span>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
