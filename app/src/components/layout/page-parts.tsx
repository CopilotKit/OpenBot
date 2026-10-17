import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `prose` is the default because configuration is mostly reading. A measure of around 65 characters
 * is where prose stays comfortable, and a row of label-and-control has no business being wider than
 * the sentence explaining it.
 *
 * `wide` exists for one page. An audit log is a table you scan, and forcing it into the prose column
 * would wrap every row. It is not a licence for anything else to be wide.
 */
export type ShellWidth = "prose" | "wide";

const WIDTHS: Record<ShellWidth, string> = {
  prose: "max-w-2xl",
  wide: "max-w-5xl",
};

/**
 * The scroller and the centred column every configuration screen sits in, without the bar. The bar
 * needs the router, so `PageShell` draws it and passes `bar` to say whether it did; this file
 * imports nothing from the router so the extension can render the same column.
 */
export function PageColumn({
  bar,
  children,
  className,
  width = "prose",
}: {
  bar: boolean;
  children: React.ReactNode;
  className?: string;
  width?: ShellWidth;
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
       * appearing inside a 630px measure with content either side of it.
       */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex w-full flex-col px-4 pb-12",
            // Without a bar above it the heading keeps the full original space.
            bar ? "pt-8" : "pt-12",
            WIDTHS[width],
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
    <header className="flex flex-col gap-2">
      <div className="flex flex-row items-center justify-between gap-4">
        <h1 className="font-bold text-2xl">{title}</h1>
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
     */
    <div
      className={cn(
        "mt-4 overflow-hidden rounded-lg border border-border bg-card dark:border-transparent",
        "[&_[data-slot=item]]:rounded-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * What a section says when it has nothing to list.
 *
 * Said in a sentence rather than drawn as an illustration with a heading: on a configuration screen
 * "nothing here yet" is a fact, not an event, and the page already told you what the section is for.
 */
export function PageEmpty({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-muted-foreground text-sm">{children}</p>;
}
