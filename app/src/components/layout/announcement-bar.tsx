import type { ReactNode } from "react";
import { IconArrowRight, IconX } from "@/components/icons";
import { Button } from "@/components/ui/button";

/**
 * The bar across the top of the page that offers something until the person closes it: Figma's
 * "Topbar / Banner". A sentence, a link that does the thing, and Close at the bar's far end.
 *
 * 48px, the height of the band every screen keeps for the sidebar's toggle, so a page whose band
 * becomes this bar, or goes back to a plain band when it is closed, does not move.
 *
 * `leading` goes before the sentence: the sidebar toggle, on a screen whose band this bar is.
 */
export function AnnouncementBar({
  action,
  label,
  leading,
  message,
  onAction,
  onDismiss,
}: {
  action: string;
  label: string;
  leading?: ReactNode;
  message: string;
  onAction(): void;
  onDismiss(): void;
}) {
  return (
    <aside
      aria-label={label}
      className="flex h-12 shrink-0 items-center gap-3.5 border-b border-foreground/12 px-6 text-sm"
    >
      {leading}
      <p className="min-w-0 truncate">{message}</p>
      <Button
        className="h-auto shrink-0 gap-1 px-0 text-foreground"
        onClick={onAction}
        variant="link"
      >
        {action}
        <IconArrowRight data-icon="inline-end" />
      </Button>
      <Button
        aria-label="Dismiss"
        className="-mr-2 ml-auto shrink-0"
        onClick={onDismiss}
        size="icon"
        variant="ghost"
      >
        <IconX />
      </Button>
    </aside>
  );
}
