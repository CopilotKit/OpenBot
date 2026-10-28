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
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { approvalInboxOptions } from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import {
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";
import { BotsSheet } from "./bots-sheet";
import { chooseBot, useChosenBotId } from "./chosen-bot";
import { MuseContext, type MuseSheetKind } from "./context";
import { MainChatLink } from "./links";
import { MenuSheet } from "./menu-sheet";
import {
  centreBot,
  inColumn,
  type MuseTab,
  statusLine,
  tabFor,
  waitingOnYou,
} from "./model";
import { NotificationsSheet } from "./notifications-sheet";
import { type MuseIcon, RoundButton } from "./ui";

/** The deployment's own name, from its brand.yaml: the name OpenBot's sidebar shows. */
const PRODUCT = appConfig.brand.productName;

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
  const search = useRouterState({
    select: (state) =>
      state.location.search as {
        agent?: unknown;
        watch?: unknown;
        settings?: unknown;
      },
  });
  const addressed = search.agent;
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
  const user = useQuery(currentUserQueryOptions());
  const userId = user.data?.id;
  const chosenId = useChosenBotId(userId);
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

  // Talking to a Bot puts it at the centre, and it stays there after the conversation closes.
  useEffect(() => {
    if (
      userId &&
      onScreenBot &&
      agents.data?.some((agent) => agent.id === onScreenBot)
    ) {
      chooseBot(userId, onScreenBot);
    }
  }, [userId, onScreenBot, agents.data]);

  // A sheet belongs to the screen it was opened on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on navigation, by design.
  useEffect(() => {
    setSheet(null);
  }, [pathname]);

  const tab = tabFor(pathname);
  // A conversation's computer or Bot settings, open beside the transcript.
  const sidePanelOpen = search.watch === true || search.settings === true;
  const column = inColumn(pathname, sidePanelOpen);
  const waiting = waitingOnYou(inbox.data).count;
  const status = statusLine({
    attention: attention.data?.find((entry) => entry.agentId === bot?.id),
    channels: channels.data,
    agentId: bot?.id,
  });

  return (
    <MuseContext.Provider value={{ bot, userId, openSheet: setSheet }}>
      <div
        className="openmuse-frame flex h-svh flex-col overflow-hidden bg-background text-foreground"
        data-openmuse-tab={tab ?? "none"}
      >
        <SelfHostBanner />
        <div className="mx-auto w-full max-w-[760px] shrink-0">
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
                className="group pointer-events-auto flex max-w-[70%] flex-col items-center gap-px rounded-2xl outline-none transition-opacity active:opacity-65 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none"
                onClick={() => setSheet("bots")}
                type="button"
              >
                {/*
                 * The Bot's own OpenBot avatar, the one its page and the Bots roster draw. With no Bot
                 * yet, the deployment's own mark stands in.
                 */}
                <span className="mt-1 mb-1 flex size-11 items-center justify-center min-[900px]:size-[52px] [&>[role=img]]:size-full! [&_svg]:size-full">
                  {bot ? (
                    <AbstractAvatar
                      name={bot.name}
                      seed={bot.avatarSeed}
                      size={52}
                    />
                  ) : (
                    <AgentOrb size="100%" />
                  )}
                </span>
                <span className="flex max-w-full items-center gap-1 font-semibold text-[16px] text-foreground tracking-[-0.4px]">
                  <span className="truncate">{bot?.name ?? PRODUCT}</span>
                  <IconChevronDown
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 motion-reduce:transition-none"
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
                label={`Needs you, ${waiting} waiting`}
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
        </div>
        {/*
         * A tab's own screen sits in OpenMuse's 760px column. Any other OpenBot page, and a conversation
         * with its side panel open, takes OpenBot's own width on a wide screen; the bars stay centred.
         */}
        <main
          className={cn(
            "openmuse-stage mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col overflow-hidden",
            !column && "min-[1100px]:max-w-none",
          )}
          data-openmuse-width={column ? "column" : "page"}
        >
          {children}
        </main>
        <div className="mx-auto w-full max-w-[760px] shrink-0">
          <nav
            aria-label={PRODUCT}
            className="flex shrink-0 justify-center px-[22px] pt-2.5 pb-[max(7px,env(safe-area-inset-bottom))] min-[900px]:pb-[22px]"
          >
            <div className="flex w-full max-w-[370px] rounded-[40px] border border-[var(--openmuse-pill-border)] bg-[var(--openmuse-pill)] p-[5px] shadow-[0_2px_18px_0_var(--openmuse-pill-shadow)]">
              {TABS.map((item) => {
                const active = item.id === tab;
                const className = cn(
                  "flex h-[47px] flex-1 items-center justify-center rounded-[28px] text-foreground outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none",
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
                  <TabLink
                    active={active}
                    className={className}
                    key={item.id}
                    label={item.label}
                    tab={item.id}
                  >
                    <item.icon className="size-[23px]" stroke={1.8} />
                  </TabLink>
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

/** Activity, Ideas and Goals are this skin's own screens; Apps is OpenBot's Connections. */
function TabLink({
  tab,
  label,
  active,
  className,
  children,
}: {
  tab: Exclude<MuseTab, "chat">;
  label: string;
  active: boolean;
  className: string;
  children: ReactNode;
}) {
  const shared = {
    "aria-current": active ? ("page" as const) : undefined,
    "aria-label": label,
    className,
  };
  return tab === "apps" ? (
    <Link {...shared} to="/connections">
      {children}
    </Link>
  ) : (
    <Link {...shared} params={{ screen: tab }} to="/s/$screen">
      {children}
    </Link>
  );
}
