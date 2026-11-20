import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { IconCheck } from "@tabler/icons-react";

import { cn } from "@/lib/utils";

/*
 * The edge is `muted-foreground`, not `input`. An unticked tickbox is nothing but its edge, and
 * `input` is the faint line of a field, about 1.3:1 against the page, a card or a muted row in light
 * and dark: on a Bot's Agents page in dark the agents not yet chosen showed no box at all. WCAG 2.2's
 * 1.4.11 asks for 3:1 between a control and what is beside it; `muted-foreground` is the app's
 * secondary text, at 4.5:1 or more on every surface in every skin. Ticked, focused and invalid keep
 * their own edges. app/tests/checkbox-contrast.test.tsx measures what the browser paints.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-muted-foreground shadow-xs outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-out focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <IconCheck className="size-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
