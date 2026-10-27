import { useRouterState } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import { cn } from "@/lib/utils";
import { PageHeader, TabHeader } from "./header";
import { MenuSheet } from "./menu-sheet";
import { isSkinScreen, tabForPath } from "./places";
import { TabBar } from "./tab-bar";

/** The height the floating tab bar covers at the column's foot: its 64px and its 22px lift. */
const TAB_SPACE = 86;

/** A page's name when it draws no heading of its own. */
export function fallbackTitle(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "");
  if (path === "/bots") return "Bots";
  if (path.startsWith("/bots/")) return "Bot";
  if (path === "/routines") return "Routines";
  if (path === "/capabilities/skills") return "Skills";
  if (path === "/capabilities/memory") return "Memory";
  if (path.startsWith("/capabilities")) return "Capabilities";
  if (path.startsWith("/connections")) return "Connections";
  return null;
}

/**
 * The name of the OpenBot page drawn under the page chrome, read from the page's own heading, so the
 * pill says exactly what the page says it is. The heading is marked, and the skin keeps it for
 * screen readers only, as OpenDuet draws a page.
 */
function usePageTitle(root: HTMLElement | null, pathname: string) {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!root) {
      setTitle(null);
      return;
    }
    const read = () => {
      const heading = root.querySelector("h1");
      if (heading && !heading.hasAttribute("data-openduet-titled"))
        heading.setAttribute("data-openduet-titled", "");
      setTitle(heading?.textContent?.trim() || fallbackTitle(pathname));
    };
    read();
    // Attributes are not watched, so marking the heading does not wake this again.
    const observer = new MutationObserver(read);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [root, pathname]);
  return title;
}

/**
 * OpenDuet's frame around every OpenBot page: one column the width of a phone, centred on a wide
 * screen. On a tab (Chat and Tasks) the header floats at the top with the menu, the mic orb and the
 * person's initial, and the frosted tab bar floats at the foot. Everything else is a page opened
 * over the app, with a back disc and its name in a pill, and no tab bar.
 *
 * The pages inside are OpenBot's own, so its chat, its tools and its approvals run unchanged. The
 * frame keeps the two things OpenBot's sidebar did beyond drawing: the one socket that keeps the
 * conversation list live, and the browser notification when a Bot starts needing the person.
 */
export function OpenDuetFrame({ children }: { children: ReactNode }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const tab = tabForPath(pathname);
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
  const title = usePageTitle(tab ? null : main, pathname);

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
        className="relative mx-auto flex min-h-0 w-full max-w-[430px] flex-1 flex-col"
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
          <PageHeader title={title} />
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
