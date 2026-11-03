import {
  type Icon,
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconBox,
  IconBrain,
  IconChecklist,
  IconChevronRight,
  IconClock,
  IconLayoutGrid,
  IconLogout,
  IconMenu2,
  IconMessages,
  IconMoon,
  IconNotes,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconShare,
  IconShieldLock,
  IconSparkles,
  IconSun,
  IconWorld,
} from "@tabler/icons-react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { useSignOut } from "@/components/app-sidebar/use-sign-out";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { useTheme } from "@/components/theme-provider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { SidebarInset, useSidebar } from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { useNavigationItems } from "@/lib/navigation";
import { LatchMenuContext } from "./context";

type Place =
  | "/"
  | "/channel/new"
  | "/bots"
  | "/approvals"
  | "/capabilities"
  | "/connections"
  | "/skills"
  | "/browser"
  | "/memory"
  | "/routines"
  | "/admin"
  | "/settings";

/**
 * Latch's frame. On a computer it is OpenBot's own sidebar frame, so the PC keeps every feature
 * where OpenBot put it. On a phone it adds Latch's bottom bar (three icons: Chats, Quick tools and
 * the ☰ menu) and its two sheets that slide up from the bottom.
 *
 * The pages inside are OpenBot's own. Chats opens OpenBot's own conversation list (the sidebar,
 * which on a phone is a sheet), so nothing about how conversations work changes.
 */
export function LatchFrame({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<"menu" | "tools" | null>(null);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [shownPath, setShownPath] = useState(pathname);
  // Going anywhere closes whichever sheet is open.
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setSheet(null);
  }

  return (
    <LatchMenuContext.Provider value={{ openMenu: () => setSheet("menu") }}>
      <SidebarShell className="h-svh overflow-hidden" width="340px">
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          <SelfHostBanner />
          {children}
          <PhoneParts sheet={sheet} setSheet={setSheet} />
        </SidebarInset>
      </SidebarShell>
    </LatchMenuContext.Provider>
  );
}

function PhoneParts({
  sheet,
  setSheet,
}: {
  sheet: "menu" | "tools" | null;
  setSheet: (sheet: "menu" | "tools" | null) => void;
}) {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  if (!isMobile) return null;
  const openChats = () => {
    setSheet(null);
    setOpenMobile(true);
  };
  const onOpenChange = (open: boolean) => {
    if (!open) setSheet(null);
  };

  return (
    <>
      <nav aria-label="Main" data-slot="latch-bar">
        <button
          aria-label="Chats"
          data-slot="latch-bar-item"
          onClick={openChats}
          type="button"
        >
          <IconNotes />
        </button>
        <button
          aria-expanded={sheet === "tools"}
          aria-label="Quick tools"
          data-slot="latch-bar-item"
          onClick={() => setSheet("tools")}
          type="button"
        >
          <IconLayoutGrid />
        </button>
        <button
          aria-expanded={sheet === "menu"}
          aria-label="Menu"
          data-slot="latch-bar-item"
          onClick={() => setSheet("menu")}
          type="button"
        >
          <IconMenu2 />
        </button>
      </nav>
      <MenuSheet
        onChats={openChats}
        onOpenChange={onOpenChange}
        open={sheet === "menu"}
      />
      <QuickTools
        onChats={openChats}
        onOpenChange={onOpenChange}
        open={sheet === "tools"}
      />
    </>
  );
}

/**
 * The ☰ menu, in Latch's order: a card of four for starting things, a list of places, one wide row,
 * a card of four for your things, a card of four for the app (Settings on the far right), and
 * Back / Forward / Share / Refresh along the bottom where the thumb is.
 */
function MenuSheet({
  onChats,
  onOpenChange,
  open,
}: {
  onChats: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { dark, setDark } = useTheme();
  const signOut = useSignOut();
  const router = useRouter();
  const isAdmin = useNavigationItems().some((item) => item.id === "admin");
  const canShare = typeof navigator !== "undefined" && !!navigator.share;

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        data-slot="latch-menu"
        showCloseButton={false}
        side="bottom"
      >
        <div aria-hidden="true" data-slot="latch-menu-handle" />
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SheetDescription className="sr-only">
          Everywhere you can go in the app.
        </SheetDescription>

        <div data-grid="" data-slot="latch-menu-card">
          <Tile icon={IconPlus} label="New chat" to="/channel/new" />
          <Tile icon={IconMessages} label="Chats" onClick={onChats} />
          <Tile icon={IconBolt} label="Bots" to="/bots" />
          <Tile icon={IconChecklist} label="Approvals" to="/approvals" />
        </div>

        <div data-slot="latch-menu-card">
          <Row icon={IconBox} label="Capabilities" to="/capabilities" />
          <Row icon={IconPlug} label="Connections" to="/connections" />
          <Row icon={IconSparkles} label="Skills" to="/skills" />
        </div>

        <div data-slot="latch-menu-card">
          <Link data-slot="latch-menu-wide" to="/routines">
            <span data-slot="latch-menu-wide-icon">
              <IconClock />
            </span>
            <span data-slot="latch-menu-row-text">
              <span data-slot="latch-menu-row-name">Routines</span>
              <span data-slot="latch-menu-row-note">
                Things your Bots do on a schedule
              </span>
            </span>
            <IconChevronRight data-slot="latch-menu-arrow" />
          </Link>
        </div>

        <div data-grid="" data-slot="latch-menu-card">
          <Tile icon={IconBrain} label="Memory" to="/memory" />
          <Tile icon={IconSearch} label="Find chat" onClick={onChats} />
          <Tile icon={IconWorld} label="Browser" to="/browser" />
          <Tile
            danger
            disabled={signOut.pending}
            icon={IconLogout}
            label="Sign out"
            onClick={signOut.run}
          />
        </div>

        <div data-grid="" data-slot="latch-menu-card">
          <Tile
            icon={dark ? IconSun : IconMoon}
            label="Theme"
            onClick={() => setDark(!dark)}
          />
          {isAdmin ? (
            <Tile icon={IconShieldLock} label="Admin" to="/admin" />
          ) : null}
          <Tile icon={IconSettings} label="Settings" to="/settings" />
        </div>

        <div data-slot="latch-menu-nav">
          <Tile
            icon={IconArrowLeft}
            label="Back"
            onClick={() => router.history.back()}
          />
          <Tile
            icon={IconArrowRight}
            label="Forward"
            onClick={() => router.history.forward()}
          />
          <Tile
            disabled={!canShare}
            icon={IconShare}
            label="Share"
            onClick={() => {
              void navigator
                .share({ url: window.location.href })
                .catch(() => {});
            }}
          />
          <Tile
            icon={IconRefresh}
            label="Refresh"
            onClick={() => window.location.reload()}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Quick tools: every place as a round button with its name under it, four to a row. */
function QuickTools({
  onChats,
  onOpenChange,
  open,
}: {
  onChats: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { dark, setDark } = useTheme();
  const isAdmin = useNavigationItems().some((item) => item.id === "admin");

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        data-slot="latch-tools"
        showCloseButton={false}
        side="bottom"
      >
        <div aria-hidden="true" data-slot="latch-menu-handle" />
        <SheetTitle data-slot="latch-tools-title">Quick tools</SheetTitle>
        <SheetDescription className="sr-only">
          Shortcuts to everything your Bots can do.
        </SheetDescription>
        <div data-slot="latch-tools-grid">
          <Tile icon={IconPlus} label="New chat" round to="/channel/new" />
          <Tile icon={IconMessages} label="Chats" onClick={onChats} round />
          <Tile icon={IconBolt} label="Bots" round to="/bots" />
          <Tile icon={IconChecklist} label="Approvals" round to="/approvals" />
          <Tile icon={IconBrain} label="Memory" round to="/memory" />
          <Tile icon={IconClock} label="Routines" round to="/routines" />
          <Tile icon={IconSparkles} label="Skills" round to="/skills" />
          <Tile icon={IconBox} label="Capabilities" round to="/capabilities" />
          <Tile icon={IconPlug} label="Connections" round to="/connections" />
          <Tile icon={IconWorld} label="Browser" round to="/browser" />
          <Tile
            icon={dark ? IconSun : IconMoon}
            label={dark ? "Light" : "Dark"}
            onClick={() => setDark(!dark)}
            round
          />
          {isAdmin ? (
            <Tile icon={IconShieldLock} label="Admin" round to="/admin" />
          ) : null}
          <Tile icon={IconSettings} label="Settings" round to="/settings" />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** An icon over a small label: a link when it goes somewhere, a button when it does something. */
function Tile({
  danger,
  disabled,
  icon: Glyph,
  label,
  onClick,
  round,
  to,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: Icon;
  label: string;
  onClick?: () => void;
  round?: boolean;
  to?: Place;
}) {
  const body = (
    <>
      <span data-slot="latch-tile-icon">
        <Glyph />
      </span>
      <span data-slot="latch-tile-label">{label}</span>
    </>
  );
  const marks = {
    "data-danger": danger ? "" : undefined,
    "data-round": round ? "" : undefined,
    "data-slot": "latch-menu-tile",
  };
  if (to) {
    return (
      <Link {...marks} to={to}>
        {body}
      </Link>
    );
  }
  return (
    <button {...marks} disabled={disabled} onClick={onClick} type="button">
      {body}
    </button>
  );
}

/** A list row: icon, name, arrow, with the line between rows starting under the name. */
function Row({
  icon: Glyph,
  label,
  to,
}: {
  icon: Icon;
  label: string;
  to: Place;
}) {
  return (
    <Link data-slot="latch-menu-row" to={to}>
      <Glyph />
      <span data-slot="latch-menu-row-text">
        <span data-slot="latch-menu-row-name">{label}</span>
      </span>
      <IconChevronRight data-slot="latch-menu-arrow" />
    </Link>
  );
}
