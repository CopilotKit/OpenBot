import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  SidebarProvider,
  SidebarResizeProvider,
} from "@/components/ui/sidebar";
import {
  applySidebarOpen,
  parseStoredSidebarOpen,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  sidebarWidthStyle,
  storedSidebarWidth,
} from "@/lib/sidebar";
import { cn } from "@/lib/utils";

/**
 * The sidebar's gutters: the header, content and footer already sit 8px in from the edge; every
 * item inside them starts 10px further in, so the search icon, the avatars, the nav icons and the
 * person's avatar share one left edge.
 */
const SIDEBAR_GUTTER = "[&_[data-sidebar=menu-button]]:px-2.5";

const PanelAvailableContext = createContext(true);

/**
 * Whether the open section has a panel to show. Only the app's sidebar of sections ever says no; the
 * page's "Show sidebar" button asks, so it never offers a panel there is not.
 */
export function useSidebarPanelAvailable(): boolean {
  return useContext(PanelAvailableContext);
}

/**
 * The frame the three shells — app, admin, settings — hang their sidebar in.
 *
 * It exists for one reason: the open/closed state has to outlive a reload, and the primitive's
 * `SidebarProvider` cannot do that on its own (it writes a cookie nothing reads and hardcodes
 * `defaultOpen` to true). Driving it as controlled state is a dozen lines, and three copies of a
 * dozen lines is three chances for one shell to forget the preference the other two remember.
 *
 * The three shells share one width (`SIDEBAR_WIDTH`), so the sidebar's edge stays put going between
 * them. Dragging it (`SidebarRail`) in any shell changes it for all three. Beside a strip that width
 * is the strip and the panel together. However wide it was left, it takes no more than
 * `SIDEBAR_MAX_SHARE` of the window, so zooming in never leaves the work a sliver beside it.
 *
 * `panel` is for a sidebar of sections (the app's), where the open section may have no panel. Then
 * the panel is folded away without touching the person's own choice to keep it open or closed, and
 * asking for it (⌘B, the edge) calls `reveal`, which opens a section that has one.
 */
export function SidebarShell({
  children,
  className,
  panel,
}: {
  children: ReactNode;
  className?: string;
  panel?: { available: boolean; reveal: () => void };
}) {
  // Read before the first paint, so a shell somebody left collapsed never flashes open.
  const [open, setOpen] = useState(() =>
    parseStoredSidebarOpen(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)),
  );
  const [width, setWidth] = useState(() =>
    storedSidebarWidth((key) => window.localStorage.getItem(key)),
  );
  // While the edge is dragged, the sidebar follows the pointer instead of easing after it.
  const [resizing, setResizing] = useState(false);
  const resize = useMemo(
    () => ({
      setWidth: (pixels: number) => setWidth(`${pixels}px`),
      commitWidth: (pixels: number) =>
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(pixels)),
      setResizing,
    }),
    [],
  );

  const available = panel?.available ?? true;
  const reveal = panel?.reveal;
  const changeOpen = useCallback(
    (next: boolean) => {
      if (next && !available) reveal?.();
      setOpen(next);
    },
    [available, reveal],
  );

  useEffect(() => {
    applySidebarOpen(open, {
      setStoredValue: (key, value) => window.localStorage.setItem(key, value),
    });
  }, [open]);

  return (
    <SidebarProvider
      className={cn(SIDEBAR_GUTTER, className)}
      data-resizing={resizing ? "" : undefined}
      onOpenChange={changeOpen}
      open={open && available}
      /*
       * `--sidebar-width-mobile` is set for the shape's sake and currently goes unread: the
       * primitive's mobile branch styles its Sheet from a hardcoded 18rem. Below 768px the sidebar
       * is that Sheet, which is also why the stored preference never reaches it — a panel that
       * covers the screen it overlays has no business being open before anybody asked for it.
       */
      style={
        {
          "--sidebar-width": sidebarWidthStyle(width, {
            besideStrip: panel !== undefined,
          }),
          "--sidebar-width-mobile": "20rem",
        } as CSSProperties
      }
    >
      <PanelAvailableContext.Provider value={available}>
        <SidebarResizeProvider value={resize}>{children}</SidebarResizeProvider>
      </PanelAvailableContext.Provider>
    </SidebarProvider>
  );
}
