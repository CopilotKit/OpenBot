import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * A notice: a sentence or two about how things stand, set apart from the page around it. Couldn't
 * save, the desktop app is offline, everyone's Bots share one computer, restoring this computer.
 *
 * The kit has no notice of its own yet, so it speaks the language of the kit's status badge and its
 * warning table row: the status's subtle fill, a glyph in the status colour and the words in ink,
 * no edge, 12px corners. `neutral` is the secondary fill with muted words, for something worth
 * knowing that is not a problem. The variants are the badge's, so a status reads the same in both.
 * The legacy kit draws the outlined box its screens drew by hand (skins/legacy-base.css).
 *
 * `icon` leads in the status colour; `action` sits at the end (Retry, Resume task), and the notice
 * centres on it. Say what the notice is to a screen reader as the moment needs: `role="alert"` for a
 * failure the person caused just now, `role="status"` for something that changes on its own.
 */
const noticeVariants = cva(
  "flex items-start gap-3 rounded-notice border px-notice-x py-notice-y text-sm has-data-[slot=notice-action]:items-center",
  {
    variants: {
      variant: {
        success:
          "border-notice-edge-success bg-success-subtle text-foreground *:data-[slot=notice-icon]:text-success",
        warning:
          "border-notice-edge-warning bg-warning-subtle text-foreground *:data-[slot=notice-icon]:text-warning",
        destructive:
          "border-notice-edge-destructive bg-destructive-subtle text-foreground *:data-[slot=notice-icon]:text-destructive",
        additional:
          "border-notice-edge-additional bg-additional-subtle text-foreground *:data-[slot=notice-icon]:text-additional",
        neutral:
          "border-notice-edge-neutral bg-notice-neutral text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

function Notice({
  action,
  children,
  className,
  icon,
  variant = "neutral",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof noticeVariants> & {
    /** A glyph before the words, drawn in the status colour. */
    icon?: React.ReactNode;
    /** A control at the end: a button, or a few side by side. */
    action?: React.ReactNode;
  }) {
  return (
    <div
      data-slot="notice"
      data-variant={variant}
      className={cn(noticeVariants({ variant }), className)}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="mt-0.5 flex shrink-0 [&_svg:not([class*='size-'])]:size-4"
          data-slot="notice-icon"
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1" data-slot="notice-content">
        {children}
      </div>
      {action ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2"
          data-slot="notice-action"
        >
          {action}
        </div>
      ) : null}
    </div>
  );
}

export { Notice, noticeVariants };
