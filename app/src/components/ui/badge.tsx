import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * The UI Kit's "Badges".
 *
 * Icon+Text is a status: a 32px pill in its status's subtle fill, the icon in the status colour and
 * the label in 14px ink, 8px in on the icon's side and 12px at the end. `success`, `warning`,
 * `destructive` and `additional` are the kit's status colours (theme.css); `neutral` is the
 * secondary fill.
 *
 * Numeric (`count`) is how many things wait: a 24px ink circle with the count in 12px, which a
 * longer number widens. Its measures are tokens, which the skins set back to the 11px pill they were
 * drawn with (skins/legacy-base.css). A count says nothing read alone, so the caller names it
 * (`aria-label`) or puts it beside what it counts.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-full whitespace-nowrap tabular-nums [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        success: "bg-success-subtle text-foreground [&_svg]:text-success",
        warning: "bg-warning-subtle text-foreground [&_svg]:text-warning",
        destructive:
          "bg-destructive-subtle text-foreground [&_svg]:text-destructive",
        additional:
          "bg-additional-subtle text-foreground [&_svg]:text-additional",
        neutral: "bg-secondary text-secondary-foreground",
        count:
          "h-badge-count min-w-badge-count bg-primary px-badge-count-x text-badge-count font-(--badge-count-weight) text-primary-foreground",
      },
    },
    compoundVariants: [
      {
        variant: ["success", "warning", "destructive", "additional", "neutral"],
        className:
          "h-8 gap-1 px-3 text-sm has-data-[icon=inline-start]:pl-2 has-data-[icon=inline-end]:pr-2 [&_svg:not([class*='size-'])]:size-4",
      },
    ],
    defaultVariants: {
      variant: "neutral",
    },
  },
);

function Badge({
  className,
  variant = "neutral",
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
