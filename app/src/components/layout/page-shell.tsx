import { IconChevronLeft } from "@tabler/icons-react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";

/**
 * The frame every configuration screen sits in.
 *
 * WHAT THIS IS FIXING. Admin was nine pages that shared no layout: four container widths plus three
 * pages with no container at all, four heading sizes, four padding schemes, and a sidebar 20px wider
 * than the rest of the app. Three of those pages imported nothing from `components/ui` and drew
 * their own buttons, inputs and tables. The result did not read as a different screen, it read as a
 * different application — which is the impression an administrator forms at exactly the moment they
 * are deciding whether to trust it with credentials.
 *
 * The shape was never in doubt: Skills and Settings already had it. So this is that shape, extracted
 * once and used everywhere, INCLUDING by Skills and Settings. Leaving those two as hand-written
 * copies would mean three dialects rather than two, and the next screen somebody writes copies
 * whichever it happened to see first.
 */

/**
 * `prose` is the default because configuration is mostly reading. A measure of around 65 characters
 * is where prose stays comfortable, and a row of label-and-control has no business being wider than
 * the sentence explaining it.
 *
 * `wide` exists for one page. An audit log is a table you scan, and forcing it into the prose column
 * would wrap every row. It is not a licence for anything else to be wide.
 */
type ShellWidth = "prose" | "wide";

const WIDTHS: Record<ShellWidth, string> = {
  prose: "max-w-2xl",
  wide: "max-w-5xl",
};

export function PageShell({
  action,
  children,
  className,
  description,
  title,
  width = "prose",
  backButton,
}: {
  /** Sits on the title's baseline. For the page's one primary verb, if it has one. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title: string;
  width?: ShellWidth;
  backButton?: {
    linkProps: LinkProps;
    label: string;
  };
}) {
  return (
    <>
      {!!backButton && (
        <div className="max-w-7xl w-full h-14 flex items-center px-3">
          <Button
            variant="ghost"
            render={(props) => <Link {...backButton.linkProps} {...props} />}
          >
            <IconChevronLeft />
            {backButton.label}
          </Button>
        </div>
      )}
      <div
        className={cn(
          "mx-auto flex w-full flex-col px-4 py-12",
          { "pt-8": !!backButton },
          WIDTHS[width],
          className,
        )}
      >
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
        {children}
      </div>
    </>
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
        "mt-4 overflow-hidden rounded-lg border border-border bg-card",
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
