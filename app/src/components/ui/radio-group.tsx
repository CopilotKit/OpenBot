import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "@/lib/utils";

/*
 * The one control in this vocabulary that shadcn had not been pulled in for yet.
 *
 * Added rather than approximated with a Select or a set of Switches, because the question it is
 * here for — what happens to a skill slug this deployment already has — is one choice out of three
 * where all three have to be readable at once. A Select hides two of the three answers behind a
 * click, and the two that are hidden are the ones a person needs to weigh; a pair of switches
 * would let somebody pick two answers to one question.
 *
 * Styled from `checkbox.tsx` and `switch.tsx` so it sits in the same family, and it renders a real
 * grouped input underneath, which is what makes arrow keys and a screen reader work.
 */

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid gap-1.5", className)}
      {...props}
    />
  );
}

function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border border-input shadow-xs outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-out focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-checked:border-primary data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-indicator"
        className="size-1.5 rounded-full bg-primary-foreground"
      />
    </RadioPrimitive.Root>
  );
}

export { Radio, RadioGroup };
