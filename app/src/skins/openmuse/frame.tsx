import {
  IconBell,
  IconBulb,
  IconChevronDown,
  IconMenu2,
  IconMessageCircle,
  IconSquareCheck,
  IconTable,
  IconTriangleSquareCircle,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { approvalInboxOptions } from "@/lib/approvals";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import {
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { cn } from "@/lib/utils";
import { BotsSheet } from "./bots-sheet";
import { chooseBot, useChosenBotId } from "./chosen-bot";
import { MuseContext, type MuseSheetKind } from "./context";
import { MainChatLink } from "./links";
import { MenuSheet } from "./menu-sheet";
import {
  centreBot,
  type MuseTab,
  mascotTint,
  statusLine,
  tabFor,
  waitingOnYou,
} from "./model";
import { NotificationsSheet } from "./notifications-sheet";
import { Mascot, type MuseIcon, RoundButton } from "./ui";

const TABS: { id: MuseTab; label: string; icon: MuseIcon }[] = [
  { id: "chat", label: "Chat", icon: IconMessageCircle },
  { id: "activity", label: "Activity", icon: IconTable },
  { id: "ideas", label: "Ideas", icon: IconBulb },
  { id: "goals", label: "Goals", icon: IconSquareCheck },
  { id: "apps", label: "Apps", icon: IconTriangleSquareCircle },
];

/**
 * OpenMuse's shell around every OpenBot page: one centred column, the agent at the top, a bell for
 * what waits on you, and a floating pill of five tabs. The page itself is OpenBot's, untouched —
 * conversations are OpenBot's own chat routes, rendered as `children`.
 */
export function OpenMuseFrame({ children }: { children: ReactNode }) {
  // The roster's socket. OpenBot opens it in its sidebar, which this frame replaces.
  useChannelEvents();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const addressed = useRouterState({
    select: (state) => (state.location.search as { agent?: unknown }).agent,
  });
  const params = useParams({ strict: false }) as {
    channelId?: string;
    agentId?: string;
  };
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const conversation = useQuery({
    ...channelQueryOptions(params.channelId ?? ""),
    enabled: Boolean(params.channelId),
  });
  const attention = useQuery(botAttentionQueryOptions());
  const inbox = useQuery(approvalInboxOptions());
  const chosenId = useChosenBotId();
  const [sheet, setSheet] = useState<MuseSheetKind | null>(null);

  /*
   * The Bot this screen is about, when it is about one: the Bot of a one-to-one conversation, the Bot
   * a new conversation is addressed to, or the Bot whose own page is open.
   */
  const onScreenBot =
    conversation.data && conversation.data.agentIds.length === 1
      ? conversation.data.agentIds[0]
      : pathname === "/channel/new" && typeof addressed === "string"
        ? addressed
        : params.agentId;
  const bot = centreBot(agents.data, chosenId, onScreenBot);
  const defaultBotId = defaultAgentProfile(agents.data)?.id;

  // Talking to a Bot puts it at the centre, and it stays there after the conversation closes.
  useEffect(() => {
    if (onScreenBot && agents.data?.some((agent) => agent.id === onScreenBot)) {
      chooseBot(onScreenBot);
    }
  }, [onScreenBot, agents.data]);

  // A sheet belongs to the screen it was opened on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on navigation, by design.
  useEffect(() => {
    setSheet(null);
  }, [pathname]);

  const tab = tabFor(pathname);
  const waiting = waitingOnYou(inbox.data).count;
  const status = statusLine({
    attention: attention.data?.find((entry) => entry.agentId === bot?.id),
    channels: channels.data,
    agentId: bot?.id,
  });

  return (
    <MuseContext.Provider value={{ bot, defaultBotId, openSheet: setSheet }}>
      <div
        className="openmuse-frame flex h-svh flex-col overflow-hidden bg-background text-foreground"
        data-openmuse-tab={tab}
      >
        <SelfHostBanner />
        <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col">
          <header className="relative mx-5 h-[122px] shrink-0 pt-0.5 min-[900px]:h-[146px] min-[900px]:pt-3.5">
            <div className="absolute top-4 left-0">
              <RoundButton
                icon={IconMenu2}
                label="Open conversations and menu"
                onClick={() => setSheet("menu")}
              >
                {/* OpenBot's own "a Bot needs you" mark, worn as OpenMuse's dot. */}
                <span className="openmuse-menu-badge">
                  <BotsNavBadge />
                </span>
              </RoundButton>
            </div>
            <div className="pointer-events-none flex flex-col items-center">
              <button
                aria-label={
                  bot ? `${bot.name}, ${status}. Switch Bot` : "Choose a Bot"
                }
                className="group pointer-events-auto flex max-w-[70%] flex-col items-center gap-px rounded-2xl outline-none transition-opacity active:opacity-65 focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => setSheet("bots")}
                type="button"
              >
                <Mascot
                  className="size-[49px] min-[900px]:size-[58px]"
                  tint={bot ? mascotTint(bot.id, defaultBotId) : "sky"}
                />
                <span className="flex max-w-full items-center gap-1 font-semibold text-[16px] text-foreground tracking-[-0.4px]">
                  <span className="truncate">{bot?.name ?? "OpenMuse"}</span>
                  <IconChevronDown
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100"
                    stroke={2.2}
                  />
                </span>
                <span
                  className="mb-1.5 max-w-full truncate text-[11px] text-muted-foreground"
                  data-testid="openmuse-status"
                >
                  {bot ? status : agents.isPending ? "" : "No Bots yet"}
                </span>
              </button>
            </div>
            <div className="absolute top-4 right-0">
              <RoundButton
                icon={IconBell}
                label={`Notifications, ${waiting} waiting on you`}
                onClick={() => setSheet("notifications")}
              >
                {waiting > 0 ? (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-[7px] right-[9px] size-1.5 rounded-full bg-[var(--openmuse-accent)]"
                  />
                ) : null}
              </RoundButton>
            </div>
          </header>
          <main className="openmuse-stage flex min-h-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
          <nav
            aria-label="OpenMuse"
            className="flex shrink-0 justify-center px-[22px] pt-2.5 pb-[max(7px,env(safe-area-inset-bottom))] min-[900px]:pb-[22px]"
          >
            <div className="flex w-full max-w-[370px] rounded-[40px] border border-[var(--openmuse-pill-border)] bg-[var(--openmuse-pill)] p-[5px] shadow-[0_2px_18px_0_var(--openmuse-pill-shadow)]">
              {TABS.map((item) => {
                const active = item.id === tab;
                const className = cn(
                  "flex h-[47px] flex-1 items-center justify-center rounded-[28px] text-foreground outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  active
                    ? "bg-[var(--openmuse-tab-active)]"
                    : "hover:bg-[var(--openmuse-tab-hover)]",
                );
                return item.id === "chat" ? (
                  <MainChatLink
                    agentId={bot?.id}
                    aria-current={active ? "page" : undefined}
                    aria-label={item.label}
                    className={className}
                    key={item.id}
                  >
                    <item.icon className="size-[23px]" stroke={1.8} />
                  </MainChatLink>
                ) : (
                  <Link
                    aria-current={active ? "page" : undefined}
                    aria-label={item.label}
                    className={className}
                    key={item.id}
                    params={{ screen: item.id }}
                    to="/s/$screen"
                  >
                    <item.icon className="size-[23px]" stroke={1.8} />
                  </Link>
                );
              })}
            </div>
          </nav>
        </div>
      </div>
      {sheet === "menu" ? <MenuSheet onClose={() => setSheet(null)} /> : null}
      {sheet === "notifications" ? (
        <NotificationsSheet onClose={() => setSheet(null)} />
      ) : null}
      {sheet === "bots" ? <BotsSheet onClose={() => setSheet(null)} /> : null}
    </MuseContext.Provider>
  );
}
