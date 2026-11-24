import { Link } from "@tanstack/react-router";
import { BrandName } from "@/components/edition/brand-name";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { useSidebar } from "@/components/ui/sidebar";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

/**
 * The window's close, minimise and zoom buttons as Figma draws them at the sidebar's top left, in the
 * browser too ("Browser window"). Only a picture: they do nothing and are hidden from screen readers.
 * In OpenBot Desktop on macOS the window's own buttons sit in their place, so the picture keeps
 * its room there and is not drawn (`data-desktop-titlebar`, styles.css).
 */
function WindowButtons() {
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center gap-2 p-px"
      data-sidebar-window-buttons=""
    >
      {[
        "bg-(--window-close)",
        "bg-(--window-minimize)",
        "bg-(--window-zoom)",
      ].map((fill) => (
        <span
          className={cn(
            "size-3.5 rounded-full border-[0.5px] border-black/10",
            fill,
          )}
          key={fill}
        />
      ))}
    </div>
  );
}

/**
 * The app sidebar's title bar in OpenBot's own look (Figma "Sidebar", Option 2): a 48px row across
 * the strip and the panel with the window's buttons, then OpenBot's mark and name, which go home.
 * Folded to the strip, the row keeps only the buttons, centred, and the mark moves onto the strip
 * (`SectionStrip`). Like a Mac title bar, the row moves the window in OpenBot Desktop; the name
 * stays a link (`data-desktop-drag`, "deep").
 */
export function SidebarTitleBar() {
  const { state } = useSidebar();
  const folded = state === "collapsed";
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 px-2",
        folded && "justify-center",
      )}
      data-desktop-drag="deep"
      data-slot="sidebar-title-bar"
    >
      <WindowButtons />
      {folded ? null : (
        <Link
          className="flex h-10 min-w-0 items-center gap-2 rounded-full p-1 outline-hidden ring-sidebar-ring focus-visible:ring-2"
          to="/"
        >
          <OpenBotLogo className="size-6 shrink-0" />
          <span className="truncate font-bold font-brand text-base leading-[1.35]">
            <BrandName>{appConfig.brand.productName}</BrandName>
          </span>
        </Link>
      )}
    </div>
  );
}
