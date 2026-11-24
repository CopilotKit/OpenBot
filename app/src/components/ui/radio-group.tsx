import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "@/lib/utils";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-3", className)}
      {...props}
    />
  );
}

/*
 * The UI Kit's "Radio": a 16px circle that, chosen, takes the tickbox's ink on its edge and on an
 * 8px dot inside. Every other state is the tickbox's (checkbox.tsx): its edge at rest and under
 * the pointer, the 2px band when focused, red when invalid, the frame's gray when disabled, and the
 * skins' own look of each. The chosen colour and the dot when disabled, which has no fill under it
 * to stand on, are the radio's own tokens (theme.css: `--color-radio*`).
 */
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-full border border-check-border bg-check-bg text-radio shadow-(--check-shadow) outline-none transition-[background-color,border-color,box-shadow,color] duration-150 ease-out not-data-disabled:hover:border-check-border-hover focus-visible:border-check-focus-border focus-visible:ring-(length:--check-focus-ring) focus-visible:ring-check-focus-ring aria-invalid:border-destructive aria-invalid:bg-check-invalid-bg aria-invalid:ring-(length:--check-invalid-ring) aria-invalid:ring-destructive/20 data-checked:border-radio not-data-disabled:data-checked:hover:border-radio-hover not-data-disabled:data-checked:hover:text-radio-hover aria-invalid:data-checked:border-destructive aria-invalid:data-checked:text-destructive data-disabled:cursor-not-allowed data-disabled:border-check-disabled-border data-disabled:bg-check-disabled-bg data-disabled:opacity-(--check-disabled-opacity) data-checked:data-disabled:border-check-checked-disabled data-checked:data-disabled:text-radio-disabled",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="size-2 rounded-full bg-current"
      />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
