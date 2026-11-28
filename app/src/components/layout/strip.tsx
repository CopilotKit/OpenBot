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
 * The sidebar's strip: one icon per section with its name under it, in a narrow column beside the
 * section's panel. `header` sits at the top (the orb), `footer` at the bottom (the account), the sections
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
      {/* The strip's width, as the sections' list is, so what it holds can wrap to the strip. */}
      {footer ? (
        <div className="flex w-full shrink-0 flex-col items-center gap-1 py-1">
          {footer}
        </div>
      ) : null}
    </Sidebar>
  );
}

/** The look of a square icon button on the strip with no name under it: the account at its foot. */
export const stripItemClassName = cn(
  "relative flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/75 outline-hidden ring-sidebar-ring transition-colors",
  "hover:bg-foreground/5 hover:text-sidebar-foreground focus-visible:ring-2 [&_svg]:size-5 [&_svg]:shrink-0",
  "data-active:bg-foreground/[0.07] data-active:text-sidebar-foreground",
  "data-active:before:absolute data-active:before:top-1/2 data-active:before:-left-[6px] data-active:before:h-5 data-active:before:w-[3px] data-active:before:-translate-y-1/2 data-active:before:rounded-full data-active:before:bg-sidebar-foreground",
);

/**
 * The look of one section on the strip: its icon in a square that fills on hover, and its name
 * written under it. While its section is open the square stays filled, the name darkens, and a short
 * bar marks the strip's left edge, level with the icon.
 */
const stripSectionClassName = cn(
  "group/strip-item relative flex w-full shrink-0 flex-col items-center gap-1 rounded-md px-0.5 py-1 text-sidebar-foreground/75 outline-hidden ring-sidebar-ring transition-colors",
  "hover:text-sidebar-foreground focus-visible:ring-2 data-active:text-sidebar-foreground",
  "data-active:before:absolute data-active:before:top-5.5 data-active:before:left-0 data-active:before:h-5 data-active:before:w-[3px] data-active:before:-translate-y-1/2 data-active:before:rounded-full data-active:before:bg-sidebar-foreground",
);

/**
 * One section on the strip: its icon, with its name written under it. A link when its section is a
 * page (`render={<Link … />}`), a button otherwise. An open section's link is the current page, and an
 * open section's button is pressed.
 *
 * `end` is drawn in the icon's top-right corner: a count waiting on the person, a recording's dot.
 * Its own words are read after the section's name. `tooltip` is only for what the name doesn't say
 * (a recording in progress); without one there is no tooltip, since the name is already on screen.
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
    /** What a tooltip says, when there is more to say than the name (a recording in progress). */
    tooltip?: ReactNode;
  }) {
  const isButton = render === undefined;
  const item = useRender({
    defaultTagName: "button",
    render: tooltip ? <TooltipTrigger render={render} /> : render,
    props: mergeProps<"button">(
      {
        className: cn(stripSectionClassName, className),
        "aria-current": !isButton && active ? "page" : undefined,
        "aria-pressed": isButton ? active : undefined,
        type: isButton ? "button" : undefined,
        children: (
          <>
            <span
              className="relative flex size-9 items-center justify-center rounded-lg transition-colors group-hover/strip-item:bg-foreground/5 group-data-active/strip-item:bg-foreground/[0.07] [&_svg]:size-5 [&_svg]:shrink-0"
              data-slot="strip-icon"
            >
              <ItemIcon aria-hidden="true" stroke={1.75} />
            </span>
            <span
              className="max-w-full truncate font-medium text-xs leading-none tracking-tight"
              data-slot="strip-label"
            >
              {label}
            </span>
            {/* After the name, so it is read after it, and drawn on the icon square's top-right corner. */}
            {end ? (
              <span className="absolute top-0.5 right-[calc(50%-1.25rem)] flex">
                {end}
              </span>
            ) : null}
          </>
        ),
      },
      props,
    ),
    state: { slot: "strip-item", active },
  });
  if (!tooltip) return item;
  return (
    <Tooltip>
      {item}
      <TooltipContent align="center" side="right" sideOffset={8}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
