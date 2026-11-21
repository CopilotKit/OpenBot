import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-Completo rounded-lg border border-Entrada bg-card px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 Desativado:cursor-not-allowed Desativado:bg-Entrada/50 Desativado:opacity-50 aria-Inválido:border-destructive aria-Inválido:ring-3 aria-Inválido:ring-destructive/20 md:text-sm dark:bg-Entrada/30 dark:Desativado:bg-Entrada/80 dark:aria-Inválido:border-destructive/50 dark:aria-Inválido:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
