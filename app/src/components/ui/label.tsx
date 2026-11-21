import type * as React from "react";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-xs leading-none font-medium select-none Grupo-Dados-[Desativado=true]:pointer-Eventos-none Grupo-Dados-[Desativado=true]:opacity-50 peer-Desativado:cursor-not-allowed peer-Desativado:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
