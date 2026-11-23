import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "@/lib/utils";

function Slider({
  className,
  value,
  defaultValue,
  min = 0,
  max = 100,
  thumbLabel,
  children,
  ...props
}: SliderPrimitive.Root.Props & {
  /** The thumb's accessible name. */
  thumbLabel?: string;
}) {
  const values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min];
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      className={cn(
        "relative w-full touch-none select-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="relative flex w-full items-center py-2 data-disabled:cursor-not-allowed"
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="h-full bg-primary"
          />
        </SliderPrimitive.Track>
        {values.map((_, index) => (
          <SliderPrimitive.Thumb
            // The thumbs are in value order and never reorder.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            index={index}
            data-slot="slider-thumb"
            getAriaLabel={thumbLabel ? () => thumbLabel : undefined}
            className="block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm transition-[color,box-shadow] outline-none hover:ring-3 hover:ring-ring/50 focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:pointer-events-none"
          />
        ))}
        {children}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
