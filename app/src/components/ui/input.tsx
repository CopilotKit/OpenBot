import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * The UI Kit's field ("Dropdown" without its chevron): every measure and colour is a token in
 * theme.css, which the alternate skins set back to theirs (skins/legacy-base.css).
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-field w-full min-w-0 rounded-field border border-field-border bg-card px-field-x py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-field-placeholder hover:border-field-border-hover focus-visible:border-field-focus-border focus-visible:inset-ring-[length:var(--field-focus-band)] focus-visible:inset-ring-field-focus focus-visible:ring-[length:var(--field-focus-ring)] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-field-disabled-bg disabled:text-field-disabled disabled:opacity-(--field-disabled-opacity) aria-invalid:border-destructive aria-invalid:ring-[length:var(--field-invalid-ring)] aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-field-disabled-bg-dark dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
