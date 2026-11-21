import type * as React from "react";
import { cn } from "@/lib/utils";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

/**
 * `prose` is the default because configuration is mostly reading, and every screen uses it so none is
 * wider than another. It is `max-w-3xl`, 768px: room for a row's label
 * and its control side by side. Page and section descriptions use the column's full width, so they line
 * up with the rows under them.
 *
 * `full` exists for one page. An audit log is a table you scan, and forcing it into the prose column
 * would wrap every row. The page is exactly the window's height and does not scroll: the title sits
 * at the pane's left edge, lined up with the table's first column rather than centred above a table
 * that is not, and the children fill what is left, so the table can be the one thing that scrolls.
 * It is not a licence for anything else to be wide. It is no column, so `PageShell` draws it itself.
 */
export type ShellWidth = "prose" | "full";

/**
 * The scroller and the centred `prose` column every configuration screen sits in, without the bar. The
 * bar needs the router, so `PageShell` draws it and passes `bar` to say whether it did; this file
 * imports nothing from the router so the extension can render the same column.
 */
export function PageColumn({
  bar,
  children,
  className,
}: {
  bar: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <>
      {/*
       * The scroller. Every shell — app, admin, settings — is exactly the window's height and holds
       * the page in an inset panel that never grows past it, so a page taller than the window
       * scrolls here, inside the panel, and the panel's rounded corners stay on screen.
       *
       * `min-h-0` is the load-bearing half of `min-h-0 flex-1`: a flex item's default `min-height:
       * auto` refuses to shrink below its content, so `flex-1` alone would grow this past the panel
       * and the overflow would be clipped instead of scrolled.
       *
       * Separate from the centred column below so the scrollbar rides the pane's edge instead of
       * appearing inside the measure with content either side of it.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            /*
             * The page's rhythm lives here, so a screen gets it by being a child rather than by
             * choosing a margin. The title block sits 36px above whatever comes first, the same
             * distance Figma puts between sections. Tabs are the exception: they belong to the
             * title, so they sit 24px under it and the content 32px under them. These outrank the
             * child's own `mt-*`, which is the point: a first section or notice keeps its usual
             * margin everywhere else and loses it only here.
             */
            "mx-auto flex w-full flex-col px-4 pb-16",
            "[&>header+*]:mt-9 [&>header+nav]:mt-6 [&>header+nav+*]:mt-8",
            // Without a bar above it the heading keeps the full original space.
            bar ? "pt-8" : "pt-12",
            // Figma's 700px column, plus the gutter.
            "max-w-page",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </>
  );
}

/** The page's title, its one primary action and its description. */
export function PageHeader({
  action,
  description,
  title,
}: {
  action?: React.ReactNode;
  description?: React.ReactNode;
  title: string;
}) {
  return (
    // Figma's H2 over a light 14px line, 4px apart.
    <header className="flex flex-col gap-1" data-slot="page-header">
      <div className="flex flex-row items-center justify-between gap-4">
        <h1
          className="font-semibold text-xl leading-tight tracking-heading"
          data-slot="page-title"
        >
          {title}
        </h1>
        {action}
      </div>
      {description ? (
        <p className="text-pretty font-light text-muted-foreground text-sm">
          {description}
        </p>
      ) : null}
    </header>
  );
}

/**
 * A titled group of rows.
 *
 * The gap above a section is deliberately large. These pages are lists of unrelated decisions, and
 * the space is what stops the eye running two of them together — it is doing the work a divider
 * would otherwise do, without drawing a line.
 */
export function PageSection({
  action,
  children,
  className,
  description,
  id,
  title,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  /** For an address that opens the page at this section, as its hash. */
  id?: string;
  title?: string;
}) {
  return (
    <section className={cn("mt-9", className)} id={id}>
      {title ? (
        <div
          className={cn(
            "flex flex-row items-center justify-between gap-4",
            // Tall enough for a small button only when there is one, so a bare heading sits 12px over its rows.
            action ? "min-h-8" : null,
          )}
        >
          {/*
           * Body size and lighter than the page title, so the sections read as parts of the page
           * rather than as a second row of titles competing with it.
           */}
          <h2 className="font-semibold text-base leading-tight tracking-heading">
            {title}
          </h2>
          {action}
        </div>
      ) : null}
      {description ? (
        <p className="mt-1 text-pretty font-light text-muted-foreground text-sm">
          {description}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The column that rows live in.
 *
 * Rows are `<Item size="sm">`, each drawn as a card of its own, 2px from the next (Figma's settings
 * and Bot screens). Screens still put a `<Separator />` between rows, from when this was one card
 * divided by lines; it is not drawn here, so a screen does not have to change to get the new shape.
 * Rendering nothing when there is nothing is deliberate — an empty box reads as a thing that failed
 * to load, where absence reads as nothing to see yet.
 */
export function PageRows({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="page-rows"
      className={cn(
        "mt-3 flex flex-col gap-0.5",
        /*
         * The card is put on each child rather than on `Item`, because a screen may wrap each row
         * (Admin wraps a row and its divider to stagger them in), and the wrapper is what sits in
         * this column. A row drawn `variant="outline"` stays an outline, as Figma draws a row that
         * is not set up yet.
         */
        "[&>*:not([data-slot=separator])]:overflow-hidden [&>*:not([data-slot=separator])]:rounded-card",
        "[&>*:not([data-slot=separator],[data-variant=outline])]:bg-card",
        "[&_[data-slot=item]]:min-h-14",
        // The old dividers, between rows or inside a row's wrapper.
        "[&>[data-slot=separator][data-orientation=horizontal]]:hidden [&>*>[data-slot=separator][data-orientation=horizontal]]:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The card a page-sized form sits in: the fields, then its buttons on the right.
 *
 * For a screen that exists to fill something in, reached from a list by its Add button, with
 * `PageShell`'s back button returning to it. The same border and fill as `PageRows`, so a form and
 * a list read as the same kind of surface, padded rather than divided because it holds fields.
 */
export function PageCard({
  children,
  className,
  footer,
}: {
  children: React.ReactNode;
  className?: string;
  /** The form's buttons, Cancel then the primary action. */
  footer?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-card bg-card p-5", className)}>
      {children}
      {footer ? (
        <div className="mt-6 flex justify-end gap-2">{footer}</div>
      ) : null}
    </div>
  );
}

/**
 * What a section says when it has nothing to list, drawn as shadcn's empty state.
 *
 * A dashed box where the rows would be, so the section keeps its shape: the icon says what kind of
 * thing would be here, the title says that there is none, the description says how one arrives, and
 * `action` is the button that adds the first one when the page has one to offer.
 *
 * Only the description is required. A section that is empty for a reason rather than because
 * nothing was added yet (a feature turned off, a search with no match) can say just that.
 */
export function PageEmpty({
  action,
  children,
  icon: Icon,
  title,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
}) {
  return (
    // `isolate` gives the pattern its own stacking context, so it sits behind the text, not on it.
    <Empty className="relative isolate mt-3 overflow-hidden rounded-card border border-border">
      {/* The pattern is decoration: see `.empty-pattern` in styles.css and its tokens in theme.css. */}
      <div aria-hidden className="empty-pattern" />
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
        ) : null}
        {title ? <EmptyTitle>{title}</EmptyTitle> : null}
        {children ? <EmptyDescription>{children}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
