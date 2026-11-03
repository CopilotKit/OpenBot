import {
  type Icon,
  IconBolt,
  IconBox,
  IconBrain,
  IconChecklist,
  IconChevronRight,
  IconClock,
  IconHome,
  IconLogout,
  IconMenu2,
  IconMessages,
  IconMoon,
  IconPlug,
  IconPlus,
  IconSettings,
  IconShieldLock,
  IconSun,
} from "@tabler/icons-react";
import { Link, useRouterState } from "@tanstack/react-router";
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
import { cn } from "@/lib/utils";

/**
 * Latch's frame. On a computer it is OpenBot's own sidebar frame, so the PC keeps every feature
 * where OpenBot put it. On a phone it adds Latch's bottom bar (Home, Chats, Bots, Menu) and the
 * ☰ menu: a sheet that slides up, made of small stacked cards, most-used things first.
 *
 * The pages inside are OpenBot's own. Chats opens OpenBot's own conversation list (the sidebar,
 * which on a phone is a sheet), so nothing about how conversations work changes.
 */
export function LatchFrame({ children }: { children: ReactNode }) {
  return (
    <SidebarShell className="h-svh overflow-hidden" width="340px">
      <AppSidebar />
      <SidebarInset className="min-h-0 overflow-hidden">
        <SelfHostBanner />
        {children}
        <PhoneBar />
      </SidebarInset>
    </SidebarShell>
  );
}

/** The bottom bar, drawn only on a phone. About 48px, an icon over a small label. */
function PhoneBar() {
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [shownPath, setShownPath] = useState(pathname);
  // Going anywhere closes the menu.
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setMenuOpen(false);
  }
  if (!isMobile) return null;

  return (
    <>
      <nav aria-label="Main" data-slot="latch-bar">
        <BarLink icon={IconHome} label="Home" to="/" exact />
        <button
          data-slot="latch-bar-item"
          onClick={() => setOpenMobile(true)}
          type="button"
        >
          <IconMessages />
          <span>Chats</span>
        </button>
        <BarLink icon={IconBolt} label="Bots" to="/bots" />
        <button
          aria-expanded={menuOpen}
          data-slot="latch-bar-item"
          onClick={() => setMenuOpen(true)}
          type="button"
        >
          <IconMenu2 />
          <span>Menu</span>
        </button>
      </nav>
      <MenuSheet
        onChats={() => {
          setMenuOpen(false);
          setOpenMobile(true);
        }}
        onOpenChange={setMenuOpen}
        open={menuOpen}
      />
    </>
  );
}

function BarLink({
  exact,
  icon: Glyph,
  label,
  to,
}: {
  exact?: boolean;
  icon: Icon;
  label: string;
  to: "/" | "/bots";
}) {
  return (
    <Link activeOptions={{ exact: !!exact }} data-slot="latch-bar-item" to={to}>
      <Glyph />
      <span>{label}</span>
    </Link>
  );
}

/** Where the menu's list rows go, each with one plain line saying what is there. */
const LIST = [
  {
    to: "/capabilities",
    label: "Capabilities",
    note: "Skills and tools your Bots can use",
    icon: IconBox,
  },
  {
    to: "/connections",
    label: "Connections",
    note: "Apps and accounts your Bots can reach",
    icon: IconPlug,
  },
  {
    to: "/memory",
    label: "Memory",
    note: "What your Bots remember",
    icon: IconBrain,
  },
  {
    to: "/routines",
    label: "Routines",
    note: "Things your Bots do on a schedule",
    icon: IconClock,
  },
] as const;

/**
 * The ☰ menu, as Latch draws it: a grab handle, then a card of four buttons for the most-used
 * things, a list card, and a last card of four for the app itself, Settings on the far right.
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
  const isAdmin = useNavigationItems().some((item) => item.id === "admin");

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

        <div data-slot="latch-menu-card" data-grid="">
          <GridLink icon={IconPlus} label="New chat" to="/channel/new" />
          <GridButton icon={IconMessages} label="Chats" onClick={onChats} />
          <GridLink icon={IconBolt} label="Bots" to="/bots" />
          <GridLink icon={IconChecklist} label="Approvals" to="/approvals" />
        </div>

        <div data-slot="latch-menu-card">
          {LIST.map(({ icon: Glyph, label, note, to }) => (
            <Link data-slot="latch-menu-row" key={to} to={to}>
              <Glyph />
              <span data-slot="latch-menu-row-text">
                <span data-slot="latch-menu-row-name">{label}</span>
                <span data-slot="latch-menu-row-note">{note}</span>
              </span>
              <IconChevronRight data-slot="latch-menu-arrow" />
            </Link>
          ))}
        </div>

        <div data-slot="latch-menu-card" data-grid="">
          <GridButton
            icon={dark ? IconSun : IconMoon}
            label={dark ? "Light" : "Dark"}
            onClick={() => setDark(!dark)}
          />
          {isAdmin ? (
            <GridLink icon={IconShieldLock} label="Admin" to="/admin" />
          ) : null}
          <GridButton
            danger
            disabled={signOut.pending}
            icon={IconLogout}
            label="Sign out"
            onClick={signOut.run}
          />
          <GridLink icon={IconSettings} label="Settings" to="/settings" />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function GridLink({
  icon: Glyph,
  label,
  to,
}: {
  icon: Icon;
  label: string;
  to: "/channel/new" | "/bots" | "/approvals" | "/admin" | "/settings";
}) {
  return (
    <Link data-slot="latch-menu-tile" to={to}>
      <Glyph />
      <span>{label}</span>
    </Link>
  );
}

function GridButton({
  danger,
  disabled,
  icon: Glyph,
  label,
  onClick,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: Icon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(danger && "text-destructive")}
      data-danger={danger ? "" : undefined}
      data-slot="latch-menu-tile"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Glyph />
      <span>{label}</span>
    </button>
  );
}
