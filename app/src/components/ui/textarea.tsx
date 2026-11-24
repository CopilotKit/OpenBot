import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-field border border-field-border bg-card px-field-x py-field-y text-base transition-colors outline-none placeholder:text-field-placeholder hover:border-field-border-hover focus-visible:border-field-focus-border focus-visible:inset-ring-[length:var(--field-focus-band)] focus-visible:inset-ring-field-focus focus-visible:ring-[length:var(--field-focus-ring)] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-field-disabled-bg disabled:text-field-disabled disabled:opacity-(--field-disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-[length:var(--field-invalid-ring)] aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-field-disabled-bg-dark dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
