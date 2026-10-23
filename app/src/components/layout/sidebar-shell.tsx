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
  parseStoredSidebarWidth,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_PREFIX,
} from "@/lib/sidebar";

/**
 * The frame the three shells — app, admin, settings — hang their sidebar in.
 *
 * It exists for one reason: the open/closed state has to outlive a reload, and the primitive's
 * `SidebarProvider` cannot do that on its own (it writes a cookie nothing reads and hardcodes
 * `defaultOpen` to true). Driving it as controlled state is a dozen lines, and three copies of a
 * dozen lines is three chances for one shell to forget the preference the other two remember.
 *
 * `width` is what differs between the shells before anybody resizes one. The app's roster earns
 * 340px because its rows are two-line message previews; admin and settings hold short nav labels and
 * earn 300px. Dragging the sidebar's edge (`SidebarRail`) changes it, and each shell remembers its
 * own under its `name`.
 */
export function SidebarShell({
  children,
  className,
  name,
  width: defaultWidth,
}: {
  children: ReactNode;
  className?: string;
  /** Whose width this is: each shell remembers its own, under this name. */
  name: string;
  /** The width before anybody drags the sidebar's edge. */
  width: string;
}) {
  // Read before the first paint, so a shell somebody left collapsed never flashes open.
  const [open, setOpen] = useState(() =>
    parseStoredSidebarOpen(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)),
  );
  const widthKey = `${SIDEBAR_WIDTH_STORAGE_PREFIX}${name}`;
  const [width, setWidth] = useState(() =>
    parseStoredSidebarWidth(
      window.localStorage.getItem(widthKey),
      defaultWidth,
    ),
  );
  // While the edge is dragged, the sidebar follows the pointer instead of easing after it.
  const [resizing, setResizing] = useState(false);
  const resize = useMemo(
    () => ({
      setWidth: (pixels: number) => setWidth(`${pixels}px`),
      commitWidth: (pixels: number) =>
        window.localStorage.setItem(widthKey, String(pixels)),
      setResizing,
    }),
    [widthKey],
  );

  useEffect(() => {
    applySidebarOpen(open, {
      setStoredValue: (key, value) => window.localStorage.setItem(key, value),
    });
  }, [open]);

  return (
    <SidebarProvider
      className={className}
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
