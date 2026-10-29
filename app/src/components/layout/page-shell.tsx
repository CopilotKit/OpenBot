import { IconChevronLeft } from "@tabler/icons-react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { PageColumn, PageHeader, type ShellWidth } from "./page-parts";
import { SidebarToggle, useSidebarToggleVisible } from "./sidebar-toggle";

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
  /*
   * The bar carries the toggle and the Back link, and is drawn when it has at least one of them.
   * The screens with a Back link already drew exactly this bar, so for them nothing changes; what
   * changed is that a sidebar is now reason enough on its own, because the toggle has to sit at the
   * pane's left edge in both states and the prose column is centred — a control inside it would be
   * 400px from the edge it belongs to on a wide screen. Drawing it with neither would be a 56px
   * band holding nothing, which reads as a layout bug rather than as chrome.
   *
   * The question is whether the toggle will DRAW, not whether a sidebar exists: it hides itself on
   * a desktop-width window while the sidebar is already open, which is most of the time on these
   * screens. Asking `useSidebarToggleVisible` rather than re-deriving the condition here is what
   * keeps the two from drifting apart and reintroducing that empty band. It also still answers false
   * on `/assist` and `/link/slack`, which draw PageShell directly under `_authed` with no sidebar
   * provider at all, so there is nothing for a toggle to act on there.
   */
  const showToggle = useSidebarToggleVisible();
  const bar = showToggle || !!backButton;

  const header = (
    <PageHeader title={title} action={action} description={description} />
  );

  const barRow = bar ? (
    <div className="max-w-7xl w-full h-14 flex items-center gap-1 px-3">
      {showToggle ? <SidebarToggle /> : null}
      {!!backButton && (
        <Button
          variant="ghost"
          render={(props) => <Link {...backButton.linkProps} {...props} />}
        >
          <IconChevronLeft />
          {backButton.label}
        </Button>
      )}
    </div>
  ) : null;

  if (width === "full") {
    return (
      /*
       * One viewport, never scrolls. `min-w-0` lets a table wider than the pane scroll inside its own
       * container instead of pushing the page sideways.
       */
      <div className="flex h-dvh min-w-0 flex-col overflow-hidden">
        {barRow}
        <div className={cn("shrink-0 px-4", bar ? "pt-8" : "pt-12")}>
          {header}
        </div>
        <div className={cn("mt-6 flex min-h-0 flex-1 flex-col", className)}>
          {children}
        </div>
      </div>
    );
  }

  return (
    <>
      {barRow}
      <PageColumn bar={bar} className={className}>
        {header}
        {children}
      </PageColumn>
    </>
  );
}

export { PageCard, PageEmpty, PageRows, PageSection } from "./page-parts";
