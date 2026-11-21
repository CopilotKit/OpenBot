import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { Icon } from "@tabler/icons-react";
import type * as React from "react";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The sidebar's strip: one icon per section, in a column as wide as an icon, beside the section's
 * panel. `header` sits at the top (the orb), `footer` at the bottom (the account), the sections
 * between them.
 *
 * A sidebar of its own (`collapsible="none"`) inside the app's sidebar, so hiding the panel shrinks
 * the app's sidebar down to this and nothing here moves.
 *
 * In OpenBot Desktop on macOS the window's close, minimise and zoom buttons sit over the strip's
 * top, about 21 to 37px down (`data-desktop-titlebar`, macOS only), so the strip then starts 32px lower,
 * below them, level with the panel beside it (`SectionPanel`), and the room it leaves above the orb
 * moves the window (`data-desktop-drag`). Windows has its own title bar, and a browser none.
 */
export function Strip({
  header,
  children,
  footer,
  className,
}: {
  header?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Sidebar
      collapsible="none"
      data-slot="strip"
      data-desktop-drag=""
      className={cn(
        "w-(--sidebar-width-icon) shrink-0 items-center bg-transparent py-1 in-data-[desktop-titlebar=overlay]:pt-9",
        className,
      )}
    >
      {header ? (
        <div className="flex h-12 shrink-0 items-center justify-center">
          {header}
        </div>
      ) : null}
      <nav
        aria-label="Sections"
        className="no-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-1"
      >
        {children}
      </nav>
      {footer ? (
        <div className="flex shrink-0 flex-col items-center gap-1 py-1">
          {footer}
        </div>
      ) : null}
    </Sidebar>
  );
}

/**
 * The look of one icon on the strip: a square that fills on hover, and while its section is open
 * stays filled with a short bar at the strip's left edge.
 */
export const stripItemClassName = cn(
  "relative flex size-9 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/75 outline-hidden ring-sidebar-ring transition-colors",
  "hover:bg-foreground/5 hover:text-sidebar-foreground focus-visible:ring-2 [&_svg]:size-5 [&_svg]:shrink-0",
  "data-active:bg-foreground/[0.07] data-active:text-sidebar-foreground",
  "data-active:before:absolute data-active:before:top-1/2 data-active:before:-left-[6px] data-active:before:h-5 data-active:before:w-[3px] data-active:before:-translate-y-1/2 data-active:before:rounded-full data-active:before:bg-sidebar-foreground",
);

/**
 * One section's icon on the strip. A link when its section is a page (`render={<Link … />}`), a
 * button otherwise. Its name is read out with it and shown in a tooltip to the right; an open
 * section's link is the current page, and an open section's button is pressed.
 *
 * `end` is drawn in the icon's top-right corner: a count waiting on the person, a recording's dot.
 * Its own words are read after the section's name.
 */
export function StripItem({
  label,
  icon: ItemIcon,
  active = false,
  end,
  tooltip,
  render,
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    label: string;
    icon: Icon;
    active?: boolean;
    end?: ReactNode;
    /** What the tooltip says, when it is more than the name (a recording in progress). */
    tooltip?: ReactNode;
  }) {
  const isButton = render === undefined;
  const item = useRender({
    defaultTagName: "button",
    render: <TooltipTrigger render={render} />,
    props: mergeProps<"button">(
      {
        className: cn(stripItemClassName, className),
        "aria-current": !isButton && active ? "page" : undefined,
        "aria-pressed": isButton ? active : undefined,
        type: isButton ? "button" : undefined,
        children: (
          <>
            <ItemIcon aria-hidden="true" stroke={1.75} />
            <span className="sr-only">{label}</span>
            {end ? (
              <span className="absolute -top-0.5 -right-0.5 flex">{end}</span>
            ) : null}
          </>
        ),
      },
      props,
    ),
    state: { slot: "strip-item", active },
  });
  return (
    <Tooltip>
      {item}
      <TooltipContent align="center" side="right" sideOffset={8}>
        {tooltip ?? label}
      </TooltipContent>
    </Tooltip>
  );
}
