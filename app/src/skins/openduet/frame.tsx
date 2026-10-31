import { useRouterState } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useState } from "react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { cn } from "@/lib/utils";
import { PageHeader, TabHeader } from "./header";
import { MenuSheet } from "./menu-sheet";
import { columnFor, isSkinScreen, tabForPath } from "./places";
import { TabBar } from "./tab-bar";

/** The height the floating tab bar covers at the column's foot: its 64px and its 22px lift. */
const TAB_SPACE = 86;

/** How wide each kind of column may grow; see `columnFor`. */
const COLUMN_WIDTH = {
  phone: "max-w-[430px]",
  pane: "max-w-[830px]",
  page: "max-w-none",
} as const;

/**
 * OpenDuet's frame around every OpenBot page.
 *
 * Chat and Tasks are one column the width of a phone, centred on a wide screen, with the header
 * floating at the top (the menu, the orb and the person's initial) and the frosted tab bar at the
 * foot. When a conversation opens its Bot's details or computer, the column grows by OpenBot's own
 * 400px pane, so the computer sits beside the conversation as it does in OpenBot. Every other page
 * opens over the app with a back disc and keeps OpenBot's own width, so a Bot's page or Admin is as
 * roomy as OpenBot made it, in OpenDuet's colours and type.
 *
 * The pages inside are OpenBot's own, so its chat, its tools and its approvals run unchanged. The
 * frame keeps the two things OpenBot's sidebar did beyond drawing: the one socket that keeps the
 * conversation list live, and the browser notification when a Bot starts needing the person.
 */
export function OpenDuetFrame({ children }: { children: ReactNode }) {
  const location = useRouterState({ select: (state) => state.location });
  const pathname = location.pathname;
  const tab = tabForPath(pathname);
  const column = columnFor(pathname, location.search);
  const ownScreen = isSkinScreen(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  // Any navigation closes the menu, including a conversation picked from inside it.
  const [shownPath, setShownPath] = useState(pathname);
  if (shownPath !== pathname) {
    setShownPath(pathname);
    setMenuOpen(false);
  }
  // One socket for the app: it keeps the conversation list and its working dots live.
  useChannelEvents();
  const [main, setMain] = useState<HTMLElement | null>(null);

  return (
    <div
      className="flex h-svh flex-col overflow-hidden bg-openduet-surface text-openduet-ink"
      data-openduet-frame=""
    >
      {/*
       * OpenBot's Bots badge is what sends the browser notification when a Bot starts needing the
       * person. The menu draws its own badge from the same count, so this one is mounted unseen,
       * only to keep that notification coming.
       */}
      <div hidden>
        <BotsNavBadge />
      </div>
      <SelfHostBanner />
      <div
        className={cn(
          "relative mx-auto flex min-h-0 w-full flex-1 flex-col",
          COLUMN_WIDTH[column],
        )}
        data-openduet-column={column}
        data-openduet-page={tab ? undefined : ""}
        data-openduet-tab={tab ?? undefined}
        style={{ "--openduet-tab-space": `${TAB_SPACE}px` } as CSSProperties}
      >
        {tab ? (
          <TabHeader
            floating={ownScreen}
            main={main}
            menuOpen={menuOpen}
            onMenu={() => setMenuOpen(true)}
          />
        ) : (
          <PageHeader main={main} />
        )}
        <main
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden",
            // An OpenBot page ends above the tab bar, so its composer is never under it.
            tab && !ownScreen && "pb-[92px]",
          )}
          ref={setMain}
        >
          {children}
        </main>
        {tab ? <TabBar current={tab} /> : null}
      </div>
      <MenuSheet onOpenChange={setMenuOpen} open={menuOpen} />
    </div>
  );
}
