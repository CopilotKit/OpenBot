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
 * and its control side by side. Sentences are held to `max-w-prose` (around 65 characters) inside it,
 * which is where reading stays comfortable, so the column widening does not stretch them.
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
       * The scroller, and it has to live here rather than in either shell, because the two shells
       * this frame is used under disagree about who scrolls.
       *
       * Under `_authed` — admin, settings — the document scrolls, so a page taller than the window
       * has always just worked. Under `_authed/_app` it does not: that shell is `h-svh
       * overflow-hidden` on purpose ("one viewport, never scrolls: panes scroll inside it") and its
       * `main` is `overflow-hidden` too, so a PageShell taller than the window was silently CLIPPED
       * — 246px of Skills sat below the fold with no way to reach it, by keyboard or otherwise.
       *
       * `min-h-0` is the load-bearing half of `min-h-0 flex-1`: a flex item's default `min-height:
       * auto` refuses to shrink below its content, so `flex-1` alone would grow this past the pane
       * and clip exactly as before. Under `_authed` both are inert — the parent is not a flex
       * container — and `overflow-y-auto` on an auto-height element shows no scrollbar, so those
       * eighteen screens are unaffected.
       *
       * Separate from the centred column below so the scrollbar rides the pane's edge instead of
       * appearing inside the measure with content either side of it.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            /*
             * The page's rhythm lives here, so a screen gets it by being a child rather than by
             * choosing a margin. The title block sits 32px above whatever comes first, tighter than
             * the 48px between sections, so the heading reads as part of the page it introduces
             * rather than as one more block at the same distance as all the others. Tabs are the
             * exception: they belong to the title, so they sit 24px under it and the content 32px
             * under them. These outrank the child's own `mt-*`, which is the point: a first section
             * or notice keeps its usual margin everywhere else and loses it only here.
             */
            "mx-auto flex w-full flex-col px-4 pb-16",
            "[&>header+*]:mt-8 [&>header+nav]:mt-6 [&>header+nav+*]:mt-8",
            // Without a bar above it the heading keeps the full original space.
            bar ? "pt-8" : "pt-12",
            "max-w-3xl",
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
    <header className="flex flex-col gap-2" data-slot="page-header">
      <div className="flex flex-row items-center justify-between gap-4">
        <h1 className="font-bold text-2xl" data-slot="page-title">
          {title}
        </h1>
        {action}
      </div>
      {description ? (
        <p className="max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed">
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
  title,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title?: string;
}) {
  return (
    <section className={cn("mt-12", className)}>
      {title ? (
        <div className="flex min-h-8 flex-row items-center justify-between gap-4">
          <h2 className="font-bold text-lg">{title}</h2>
          {action}
        </div>
      ) : null}
      {description ? (
        <p className="mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed">
          {description}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The card that rows live in.
 *
 * Rows are `<Item size="sm">` with a `<Separator />` between them; this is only the border around
 * them. Rendering nothing when there is nothing is deliberate — an empty bordered box reads as a
 * thing that failed to load, where absence reads as nothing to see yet.
 */
export function PageRows({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    /*
     * The rows are squared off and the card clips them. `Item` carries `rounded-lg` of its own, which
     * inside a card of divided rows painted a hover as a floating pill: a middle row has no corners,
     * and the first and last cannot be concentric with the card while sitting a border inside it.
     *
     * Every row is at least 56px, whatever it holds. A title over a description is 65px; a lone
     * line would be 48px and look stunted beside it, so it is held up to the floor. A description
     * that wraps to a second line still grows the row rather than being clipped.
     */
    <div
      className={cn(
        "mt-4 overflow-hidden rounded-lg border border-border bg-card dark:border-transparent",
        "[&_[data-slot=item]]:rounded-none [&_[data-slot=item]]:min-h-14",
        // Dividers stop 16px short of each edge, lined up with the rows' text, as Linear draws them.
        // Any depth: a screen may wrap each row and its divider, as Admin does to stagger them in.
        "[&_[data-slot=separator][data-orientation=horizontal]]:mx-4 [&_[data-slot=separator][data-orientation=horizontal]]:w-auto",
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
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4 dark:border-transparent",
        className,
      )}
    >
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
    <Empty className="mt-4 rounded-lg border border-border">
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
