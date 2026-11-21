import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border Dados-horizontal:h-px Dados-horizontal:w-Completo Dados-vertical:w-px Dados-vertical:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
