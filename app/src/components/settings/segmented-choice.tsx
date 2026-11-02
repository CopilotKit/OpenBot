import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { cn } from "@/lib/utils";

/**
 * A few choices side by side, one of them on: a radio group drawn as a segmented control, so every
 * choice is in view at once. Arrow keys move between the choices and choose as they go, and Tab
 * leaves the group, the way a radio group does.
 */
export function SegmentedChoice<Value extends string>({
  className,
  label,
  labels,
  onChange,
  options,
  value,
}: {
  className?: string;
  /** What the group chooses, for assistive tech: the row's title. */
  label: string;
  labels: Record<Value, string>;
  onChange: (value: Value) => void;
  options: readonly Value[];
  value: Value;
}) {
  return (
    <RadioGroup
      aria-label={label}
      className={cn(
        "inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted p-0.5",
        className,
      )}
      onValueChange={(next) => onChange(next as Value)}
      value={value}
    >
      {options.map((option) => (
        <Radio.Root
          className="inline-flex h-8 cursor-default select-none items-center rounded-md px-3 type-sub font-medium text-muted-foreground outline-none transition-colors duration-150 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-card data-checked:text-foreground data-checked:shadow-(--shadow-float) dark:data-checked:bg-input motion-reduce:transition-none"
          key={option}
          value={option}
        >
          {labels[option]}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
