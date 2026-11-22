import { useRouterState } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { underConnections } from "@/lib/moves/moved-apps";
import {
  isNavigationLink,
  type NavigationLink,
  useNavigationItems,
} from "@/lib/navigation";

/**
 * The sidebar's sections: one icon each on the strip. Conversations first, then the main menu's own
 * destinations (`lib/navigation.ts`), in that list's order.
 *
 * A section may have a panel beside the strip: Conversations and Bots do. A section without one folds
 * the panel away and its page takes the width.
 */
export const CONVERSATIONS = "conversations";

export type SectionId = typeof CONVERSATIONS | NavigationLink["id"];

/** Where a section lives: its id and the address its pages start with. */
export type SectionRoute = { id: SectionId; to: string };

/**
 * The section a page belongs to. Home and every conversation are Conversations'; any other page is
 * the section whose address it is or sits under (`/bots/x/activity` is Bots'). A page no section
 * owns (`/teams`, `/invitations`) belongs to none, and the strip keeps what was open.
 */
export function sectionForPath(
  pathname: string,
  routes: readonly SectionRoute[],
): SectionId | null {
  if (
    pathname === "/" ||
    pathname === "/channel" ||
    pathname.startsWith("/channel/")
  ) {
    return CONVERSATIONS;
  }
  const page = underConnections(pathname) ? "/connections" : pathname;
  const route = routes.find(
    ({ to }) => page === to || page.startsWith(`${to}/`),
  );
  return route?.id ?? null;
}

/** Whether a section has a panel beside the strip: Conversations and Bots so far. */
export function sectionHasPanel(id: SectionId): boolean {
  return id === CONVERSATIONS || id === "bots";
}

/** The addresses of the sections this person has, from the main menu. */
export function useSectionRoutes(): SectionRoute[] {
  const navigation = useNavigationItems();
  return useMemo(
    () =>
      navigation
        .filter(isNavigationLink)
        .filter((item) => item.section === "primary")
        .map((item) => ({ id: item.id, to: item.to })),
    [navigation],
  );
}

type OpenSection = {
  /** The section the strip shows as open. */
  section: SectionId;
  /** The section this page belongs to; null on a page no section owns, which keeps `section`. */
  page: SectionId | null;
  /** Open a section without leaving the page: Conversations' icon, ⌘B on a page with no panel. */
  show: (id: SectionId) => void;
};

const OpenSectionContext = createContext<OpenSection | null>(null);

/**
 * Holds which section is open. It follows the page: opening a page that belongs to a section opens
 * that section, however the page was reached. A page that belongs to none leaves it as it was.
 * `show` opens one directly, for as long as the page stays the same.
 */
export function SectionProvider({ children }: { children: ReactNode }) {
  const routes = useSectionRoutes();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // What was open before this page, read while working out where a conversation belongs.
  const lastRef = useRef<SectionId>(CONVERSATIONS);
  /*
   * A conversation is Conversations', except one opened from under its Bot in the Bots panel: that
   * panel stays, so the Bot's list the person was working through is still there. A group
   * conversation's address is a conversation too.
   */
  const onConversation =
    pathname !== "/channel/new" && /^\/(channel|group)\//.test(pathname);
  const routed = onConversation
    ? lastRef.current === "bots"
      ? "bots"
      : CONVERSATIONS
    : sectionForPath(pathname, routes);
  // What `show` picked, and the page it was picked on: a new page hands the choice back to the route.
  const [shown, setShown] = useState<{
    id: SectionId;
    pathname: string;
  } | null>(null);
  // The section open on the last page, for pages that belong to none: the page's own, or the one
  // `show` opened on it.
  const [last, setLast] = useState<SectionId>(routed ?? CONVERSATIONS);
  const section =
    shown && shown.pathname === pathname ? shown.id : (routed ?? last);
  if (section !== last) setLast(section);
  // What is on screen now, opened by the page or by `show`, is what the next conversation keeps.
  lastRef.current = section;
  const value = useMemo<OpenSection>(
    () => ({
      section,
      page: routed,
      show: (id) => setShown({ id, pathname }),
    }),
    [section, routed, pathname],
  );
  return (
    <OpenSectionContext.Provider value={value}>
      {children}
    </OpenSectionContext.Provider>
  );
}

/** The open section. Outside a `SectionProvider`, Conversations, and `show` does nothing. */
export function useOpenSection(): OpenSection {
  return (
    useContext(OpenSectionContext) ?? {
      section: CONVERSATIONS,
      page: null,
      show: () => {},
    }
  );
}
