import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * The UI Kit's "Badges".
 *
 * Icon+Text is a status: a 32px pill in its colour at 20%, the icon in that colour and the label in
 * 14px ink, 8px in on the icon's side and 12px at the end. `success`, `warning` and `destructive`
 * are the kit's colours (theme.css: `--color-badge-*`); `neutral` is the secondary fill.
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
        success:
          "bg-badge-success/20 text-foreground [&_svg]:text-badge-success",
        warning:
          "bg-badge-warning/20 text-foreground [&_svg]:text-badge-warning",
        destructive:
          "bg-badge-destructive/20 text-foreground [&_svg]:text-badge-destructive",
        neutral: "bg-secondary text-secondary-foreground",
        count:
          "h-badge-count min-w-badge-count bg-primary px-badge-count-x text-badge-count font-(--badge-count-weight) text-primary-foreground",
      },
    },
    compoundVariants: [
      {
        variant: ["success", "warning", "destructive", "neutral"],
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
