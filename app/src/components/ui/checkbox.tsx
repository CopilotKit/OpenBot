import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { IconCheck, IconMinus } from "@/components/icons";

import { cn } from "@/lib/utils";

/*
 * The UI Kit's "Checkbox label" box: ticked, half ticked (`indeterminate`) and each state a colour
 * of its own (theme.css: `--color-check-*`), which the skins set back to theirs.
 *
 * The edge is `muted-foreground`, not the kit's ink at 20% nor `input`. An unticked tickbox is
 * nothing but its edge, and either is about 1.3–1.5:1 against the page, a card or a muted row: on a
 * Bot's Agents page in dark the agents not yet chosen showed no box at all. WCAG 2.2's 1.4.11 asks
 * for 3:1 between a control and what is beside it; `muted-foreground` is the app's secondary text,
 * at 4.5:1 or more on every surface in every skin. Ticked, focused and invalid keep their own edges.
 * app/tests/checkbox-contrast.test.tsx measures what the browser paints.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-check-border bg-check-bg shadow-(--check-shadow) outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-out not-data-disabled:hover:border-check-border-hover focus-visible:border-check-focus-border focus-visible:ring-(length:--check-focus-ring) focus-visible:ring-check-focus-ring aria-invalid:border-destructive aria-invalid:bg-check-invalid-bg aria-invalid:ring-(length:--check-invalid-ring) aria-invalid:ring-destructive/20 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground not-data-disabled:data-checked:hover:border-check-checked-hover not-data-disabled:data-checked:hover:bg-check-checked-hover not-data-disabled:data-indeterminate:hover:border-check-checked-hover not-data-disabled:data-indeterminate:hover:bg-check-checked-hover aria-invalid:data-checked:border-check-checked-invalid aria-invalid:data-checked:bg-check-checked-invalid aria-invalid:data-indeterminate:border-check-checked-invalid aria-invalid:data-indeterminate:bg-check-checked-invalid data-disabled:cursor-not-allowed data-disabled:border-check-disabled-border data-disabled:bg-check-disabled-bg data-disabled:opacity-(--check-disabled-opacity) data-checked:data-disabled:border-check-checked-disabled data-checked:data-disabled:bg-check-checked-disabled data-checked:data-disabled:text-check-disabled data-indeterminate:data-disabled:border-check-checked-disabled data-indeterminate:data-disabled:bg-check-checked-disabled data-indeterminate:data-disabled:text-check-disabled",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group/check flex items-center justify-center text-current"
      >
        <IconCheck className="size-3 group-data-indeterminate/check:hidden" />
        <IconMinus className="hidden size-3 group-data-indeterminate/check:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
