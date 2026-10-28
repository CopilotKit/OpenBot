import {
  IconClockHour3,
  IconDeviceDesktop,
  IconLayoutSidebar,
  IconLogout,
  IconMenu2,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Link,
  type LinkProps,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { setBotPausedMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { botLifecycleQueryOptions } from "@/lib/bot-lifecycle/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { appConfig } from "@/lib/generated/application-config";
import { type NavigationItem, useNavigationItems } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { ComputerPane } from "./computer-pane";
import { CoworkerPersona } from "./persona";
import { botName, type Place, usePlace } from "./place";
import { IconAction, initialsOf, OpenDotsSidebar } from "./sidebar";

/** The rail's square buttons: 36px, borderless, a grey glyph that darkens on hover. */
const railButton =
  "grid size-9 place-items-center rounded-lg text-(--opendots-rail-icon) outline-none transition-colors hover:bg-(--opendots-hover) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[18px] [&_svg]:stroke-[1.75]";

function RailTip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Who is signed in, and the way out, at the foot of the rail as OpenBot keeps it in its sidebar. */
function RailUserMenu() {
  const user = useQuery(currentUserQueryOptions());
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  if (!user.data) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="Account"
            className="grid size-[29px] place-items-center rounded-full border border-(--opendots-avatar-line) bg-(--opendots-avatar) text-[10px] text-(--opendots-avatar-ink) outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          />
        }
      >
        {initialsOf(user.data)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="p-1.5" side="right">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="max-w-56 truncate">
            {user.data.name?.trim() || user.data.email}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2 px-2 py-1.5"
          disabled={signOut.isPending}
          onClick={async () => {
            await signOut.mutateAsync();
            await navigate({ to: "/sign" });
          }}
          variant="destructive"
        >
          <IconLogout />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The 48px strip at the far left: the brand, the sidebar toggle, and the few places used most. */
/** One of OpenBot's destinations as a rail button, with the Bots badge on Bots. */
function RailDestination({
  item,
  showBadge,
}: {
  item: NavigationItem;
  showBadge: boolean;
}) {
  const Icon = item.icon;
  return (
    <RailTip label={item.label}>
      <Link
        aria-label={item.label}
        className={cn(railButton, "relative")}
        to={item.to}
      >
        <Icon />
        {item.id === "bots" && showBadge ? (
          // What waits on you across every Bot. OpenBot's own badge, which also sends the
          // browser notification, so exactly one is ever mounted.
          <span className="pointer-events-none absolute -top-1 -right-1 flex">
            <BotsNavBadge />
          </span>
        ) : null}
      </Link>
    </RailTip>
  );
}

function Rail({
  newChat,
  navCollapsed,
  onToggleNav,
  showBadge,
}: {
  newChat: LinkProps;
  navCollapsed: boolean;
  onToggleNav: () => void;
  /** Whether the rail carries the Bots badge: at desktop width, where the rail is on screen. */
  showBadge: boolean;
}) {
  const navigation = useNavigationItems();
  return (
    <nav
      aria-label="Workspace navigation"
      data-opendots-chrome
      className="flex w-12 shrink-0 flex-col items-center gap-3 border-r border-(--opendots-line) bg-(--opendots-rail) px-[5px] py-4 max-md:hidden"
    >
      {/* OpenBot's own mark where OpenDots puts its monogram; the deployment owns the identity. */}
      <Link
        aria-label={`${appConfig.brand.productName} home`}
        className="mb-3 grid size-9 shrink-0 place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        to="/"
      >
        <AgentOrb size="26px" />
      </Link>
      <RailTip label={navCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
        <button
          aria-controls="opendots-sidebar"
          aria-expanded={!navCollapsed}
          aria-label={navCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={railButton}
          onClick={onToggleNav}
          type="button"
        >
          <IconLayoutSidebar />
        </button>
      </RailTip>
      <RailTip label="New chat">
        <Link {...newChat} aria-label="New chat" className={railButton}>
          <IconPlus className="size-[19px]!" />
        </Link>
      </RailTip>
      <RailTip label="Routines">
        <Link
          aria-label="Routines"
          className={railButton}
          params={{ screen: "routines" }}
          to="/s/$screen"
        >
          <IconClockHour3 />
        </Link>
      </RailTip>
      {/* OpenBot's own destinations, from the one list every frame reads. */}
      {navigation
        .filter((item) => item.section === "primary")
        .map((item) => (
          <RailDestination item={item} key={item.id} showBadge={showBadge} />
        ))}
      <div className="mt-auto flex flex-col items-center gap-3">
        {navigation
          .filter((item) => item.section === "account")
          .map((item) => (
            <RailDestination item={item} key={item.id} showBadge={false} />
          ))}
        <RailUserMenu />
      </div>
    </nav>
  );
}

/**
 * Pause and resume for the one Bot the page is about. OpenDots pauses every Dot at once; OpenBot
 * pauses each Bot on its own, so this is that Bot's switch and only appears where there is one.
 */
function PauseControl({ botId, name }: { botId: string; name: string }) {
  const lifecycle = useQuery(botLifecycleQueryOptions(botId));
  const setPaused = useMutation(setBotPausedMutationOptions(queryClient));
  if (!lifecycle.data) return null;
  const paused = lifecycle.data.paused;
  return (
    <button
      aria-label={paused ? `Resume ${name}` : `Pause ${name}`}
      className="inline-flex items-center gap-[5px] rounded-md p-1 text-[12px] text-(--opendots-pause-ink) outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-3.5"
      disabled={setPaused.isPending}
      onClick={() => setPaused.mutate({ agentId: botId, paused: !paused })}
      title={
        paused
          ? `${name} is paused. Nothing runs for you until you resume it.`
          : `Pause ${name}. Nothing runs for you until you resume it.`
      }
      type="button"
    >
      {paused ? <IconPlayerPlay /> : <IconPlayerPause />}
      <span className="max-md:hidden">{paused ? "Resume" : "Pause"}</span>
    </button>
  );
}

function Topbar({
  place,
  navCollapsed,
  onToggleNav,
  computerOpen,
  onToggleComputer,
}: {
  place: Place;
  navCollapsed: boolean;
  onToggleNav: () => void;
  computerOpen: boolean;
  onToggleComputer: () => void;
}) {
  const agents = useQuery(agentListQueryOptions());
  const name = botName(agents.data, place.botId);
  return (
    <header
      data-opendots-chrome
      className="flex h-16 shrink-0 items-center gap-4 border-b border-(--opendots-line) bg-(--opendots-topbar) px-[22px] max-md:pr-[15px] max-md:pl-12"
    >
      <button
        aria-controls="opendots-sidebar"
        aria-expanded={!navCollapsed}
        aria-label={navCollapsed ? "Show navigation" : "Hide navigation"}
        className="grid size-10 shrink-0 place-items-center rounded-lg text-(--opendots-toggle-ink) outline-none transition-colors hover:bg-(--opendots-hover) focus-visible:ring-2 focus-visible:ring-ring max-md:hidden [&_svg]:size-[18px]"
        onClick={onToggleNav}
        type="button"
      >
        <IconLayoutSidebar />
      </button>
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 flex-1 items-center gap-[13px] text-[13px] text-(--opendots-crumb) max-md:gap-[7px]"
      >
        <span className="shrink-0 max-md:hidden">Bots</span>
        <span aria-hidden className="shrink-0 max-md:hidden">
          /
        </span>
        <strong
          className="min-w-0 truncate font-medium text-(--opendots-crumb-ink)"
          data-testid="opendots-crumb"
        >
          {place.label}
        </strong>
        {place.detail ? (
          <>
            <span aria-hidden className="shrink-0">
              /
            </span>
            <strong className="min-w-0 truncate font-medium text-(--opendots-crumb-ink)">
              {place.detail}
            </strong>
          </>
        ) : null}
      </nav>
      <div className="flex shrink-0 items-center gap-[15px] max-md:gap-3">
        {place.botId && name ? (
          <PauseControl botId={place.botId} name={name} />
        ) : null}
        <IconAction
          aria-expanded={computerOpen}
          className={cn(
            "size-8 [&_svg:not([class*='size-'])]:size-[18px]",
            computerOpen && "bg-(--opendots-tab) text-foreground",
          )}
          label={computerOpen ? "Hide computer" : "Show computer"}
          onClick={onToggleComputer}
        >
          <IconDeviceDesktop />
        </IconAction>
      </div>
    </header>
  );
}

/**
 * OpenDots' frame around every OpenBot page: the icon rail, the Dots sidebar, a top bar with
 * breadcrumbs and the computer toggle, and the computer pane on the right. The page itself, chat
 * included, is OpenBot's own and renders as `children`.
 */
export function OpenDotsFrame({ children }: { children: ReactNode }) {
  // One socket for the app, opened where the roster is kept live, as OpenBot's own sidebar does.
  useChannelEvents();
  const place = usePlace();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [paneOpen, setPaneOpen] = useState(false);
  const href = useRouterState({ select: (state) => state.location.href });

  // OpenBot's own breakpoint, so the drawer and OpenBot's pages agree about what a phone is.
  const isMobile = useIsMobile();

  // A page chosen from the drawer replaces it, as tapping a row in OpenDots' drawer does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on every navigation is the point.
  useEffect(() => {
    setMobileOpen(false);
  }, [href]);

  /** New chat is with the Bot on screen when there is one, as OpenDots starts it with the open one. */
  const newChat: LinkProps =
    place.section === "chat" && place.botId
      ? { to: "/channel/new", search: { agent: place.botId } }
      : { to: "/channel/new" };

  /*
   * A conversation draws OpenBot's own Computer pane, opened by its `?watch` flag, and opens it by
   * itself when the Bot starts using the browser. The toggle drives that pane there rather than
   * opening a second screen beside it; everywhere else it opens the frame's own.
   */
  const computerOpen = place.ownsWatch ? place.watching : paneOpen;
  const toggleComputer = () => {
    if (!place.ownsWatch) {
      setPaneOpen((open) => !open);
      return;
    }
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        settings: undefined,
        watch: place.watching ? undefined : true,
      }),
    });
  };

  return (
    <div
      className="flex h-svh overflow-hidden bg-background text-foreground"
      data-opendots-frame
    >
      <Rail
        navCollapsed={navCollapsed}
        newChat={newChat}
        onToggleNav={() => setNavCollapsed((collapsed) => !collapsed)}
        showBadge={!isMobile}
      />
      {isMobile ? (
        <>
          <button
            aria-expanded={mobileOpen}
            aria-label="Open navigation"
            className="fixed top-3.5 left-2.5 z-20 grid size-9 place-items-center rounded-lg text-(--opendots-menu-ink) outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[21px]"
            data-opendots-chrome
            onClick={() => setMobileOpen(true)}
            type="button"
          >
            <IconMenu2 />
            {/* On a phone the rail is gone, so the Bots badge rides on the menu button. */}
            <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex">
              <BotsNavBadge />
            </span>
          </button>
          {/* OpenBot's own sheet: it traps focus, closes on Escape and on the scrim. */}
          <Sheet onOpenChange={setMobileOpen} open={mobileOpen}>
            <SheetContent
              className="w-[252px] max-w-[85vw] gap-0 border-(--opendots-line) bg-(--opendots-sidebar) p-0 text-foreground"
              data-opendots-chrome
              showCloseButton={false}
              side="left"
            >
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <OpenDotsSidebar
                newChat={newChat}
                onNavigate={() => setMobileOpen(false)}
                place={place}
              />
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <aside
          aria-label="Sidebar"
          className="w-[220px] shrink-0 border-r border-(--opendots-line) bg-(--opendots-sidebar)"
          data-opendots-chrome
          hidden={navCollapsed}
          id="opendots-sidebar"
        >
          <OpenDotsSidebar
            newChat={newChat}
            onNavigate={() => setMobileOpen(false)}
            place={place}
          />
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          computerOpen={computerOpen}
          navCollapsed={navCollapsed}
          onToggleComputer={toggleComputer}
          onToggleNav={() => setNavCollapsed((collapsed) => !collapsed)}
          place={place}
        />
        <SelfHostBanner />
        <div className="relative flex min-h-0 flex-1">
          <main
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            data-opendots-main
          >
            {children}
            {place.coworkerHome && place.botId ? (
              <CoworkerPersona botId={place.botId} />
            ) : null}
          </main>
          {paneOpen && !place.ownsWatch ? (
            <div
              data-opendots-chrome
              className="w-[clamp(390px,40vw,660px)] shrink-0 border-l border-(--opendots-line) max-[1100px]:fixed max-[1100px]:top-16 max-[1100px]:right-0 max-[1100px]:bottom-0 max-[1100px]:z-[15] max-[1100px]:w-[min(600px,100vw)] max-[1100px]:shadow-(--opendots-pane-shadow)"
            >
              <ComputerPane
                defaultBotId={place.botId}
                onClose={() => setPaneOpen(false)}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
