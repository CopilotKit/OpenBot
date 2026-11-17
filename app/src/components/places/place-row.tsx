import { Link, type LinkOptions } from "@tanstack/react-router";
import type {
  ComponentProps,
  ComponentType,
  ReactNode,
  RefObject,
} from "react";
import { cn } from "@/lib/utils";

type PlaceRowProps = Omit<ComponentProps<"button">, "title"> & {
  /** A 20px avatar or icon. */
  media?: ReactNode;
  title: ReactNode;
  /** A second muted line. The row grows to fit it. */
  detail?: ReactNode;
  trailing?: ReactNode;
  /** Makes the row a link. Without it the row is a button. */
  to?: LinkOptions;
  onClick?: () => void;
  current?: boolean;
  className?: string;
};

/**
 * One line of a place's list. A link when it has a destination, otherwise a button, which can also
 * be the `render` target of a Popover or Menu trigger: the trigger's props arrive in the rest.
 */
export function PlaceRow({
  media,
  title,
  detail,
  trailing,
  to,
  onClick,
  current,
  className,
  ...buttonProps
}: PlaceRowProps) {
  const classes = cn(
    "flex w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-foreground/5",
    detail ? "min-h-8 py-1" : "h-8",
    current && "bg-foreground/5",
    className,
  );
  const content = (
    <>
      {media ? <span className="shrink-0">{media}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate">{title}</span>
        {detail ? (
          <span className="truncate text-muted-foreground text-xs">
            {detail}
          </span>
        ) : null}
      </span>
      {trailing ? <span className="ml-auto shrink-0">{trailing}</span> : null}
    </>
  );

  if (to) {
    return (
      <Link
        {...to}
        activeProps={{ className: "bg-foreground/5" }}
        className={classes}
        onClick={onClick}
      >
        {content}
      </Link>
    );
  }
  return (
    <button
      {...buttonProps}
      className={classes}
      onClick={onClick}
      type="button"
    >
      {content}
    </button>
  );
}

/** A small uppercase section heading, with a count at the right when there is one. */
export function PlaceHeading({
  children,
  count,
}: {
  children: ReactNode;
  count?: number;
}) {
  return (
    <h3 className="flex items-center px-2 pt-3 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {typeof count === "number" && count > 0 ? (
        <span className="shrink-0">{count}</span>
      ) : null}
    </h3>
  );
}

/** One muted sentence for a list with nothing in it. */
export function PlaceEmpty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-3 text-muted-foreground text-xs">{children}</p>;
}

/**
 * Drawn over the top-right corner of a strip button. The button's label names the place, so the
 * drawn badge is hidden from assistive technology and the state is said in words beside it, which
 * the button reads as its description.
 */
export function StripBadge({
  count,
  dot,
  pulse,
}: {
  count?: number;
  dot?: boolean;
  pulse?: boolean;
}) {
  if (count !== undefined && count > 0) {
    return (
      <>
        <span
          aria-hidden
          className="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-medium text-[10px] text-primary-foreground leading-none"
          data-slot="strip-badge"
        >
          {count > 9 ? "9+" : count}
        </span>
        <span className="sr-only">
          {count === 1 ? "1 needs you" : `${count} need you`}
        </span>
      </>
    );
  }
  if (dot) {
    return (
      <>
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 right-0 size-2 rounded-full bg-primary"
          data-slot="strip-badge"
        />
        <span className="sr-only">Unread</span>
      </>
    );
  }
  if (pulse) {
    return (
      <>
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 right-0 size-2 animate-pulse rounded-full bg-indigo-500 motion-reduce:animate-none"
          data-slot="strip-badge"
        />
        <span className="sr-only">Running</span>
      </>
    );
  }
  return null;
}

/**
 * A place in the strip. `List` is the place's list, `Badge` is drawn on its strip button, `Action`
 * sits at the right of the list's header.
 */
export type PlaceEntry = {
  List: ComponentType<{ scrollRoot: RefObject<HTMLDivElement | null> }>;
  Badge?: ComponentType;
  Action?: ComponentType;
};
