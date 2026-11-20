import {
  type CSSProperties,
  type ReactNode,
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
  storedSidebarWidth,
} from "@/lib/sidebar";
import { cn } from "@/lib/utils";

/**
 * The sidebar's gutters: the header, content and footer already sit 8px in from the edge; every
 * item inside them starts 10px further in, so the search icon, the avatars, the nav icons and the
 * person's avatar share one left edge.
 */
const SIDEBAR_GUTTER = "[&_[data-sidebar=menu-button]]:px-2.5";

/**
 * The frame the three shells — app, admin, settings — hang their sidebar in.
 *
 * It exists for one reason: the open/closed state has to outlive a reload, and the primitive's
 * `SidebarProvider` cannot do that on its own (it writes a cookie nothing reads and hardcodes
 * `defaultOpen` to true). Driving it as controlled state is a dozen lines, and three copies of a
 * dozen lines is three chances for one shell to forget the preference the other two remember.
 *
 * The three shells share one width (`SIDEBAR_WIDTH`), so the sidebar's edge stays put going between
 * them. Dragging it (`SidebarRail`) in any shell changes it for all three.
 */
export function SidebarShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
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

  useEffect(() => {
    applySidebarOpen(open, {
      setStoredValue: (key, value) => window.localStorage.setItem(key, value),
    });
  }, [open]);

  return (
    <SidebarProvider
      className={cn(SIDEBAR_GUTTER, className)}
      data-resizing={resizing ? "" : undefined}
      onOpenChange={setOpen}
      open={open}
      /*
       * `--sidebar-width-mobile` is set for the shape's sake and currently goes unread: the
       * primitive's mobile branch styles its Sheet from a hardcoded 18rem. Below 768px the sidebar
       * is that Sheet, which is also why the stored preference never reaches it — a panel that
       * covers the screen it overlays has no business being open before anybody asked for it.
       */
      style={
        {
          "--sidebar-width": width,
          "--sidebar-width-mobile": "20rem",
        } as CSSProperties
      }
    >
      <SidebarResizeProvider value={resize}>{children}</SidebarResizeProvider>
    </SidebarProvider>
  );
}
