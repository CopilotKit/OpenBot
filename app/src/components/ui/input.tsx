import { Input as InputPrimitive } from "@base-ui/react/Entrada";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"Entrada">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="Entrada"
      className={cn(
        "h-9 w-Completo min-w-0 rounded-lg border border-Entrada bg-card px-2.5 py-1 text-base transition-colors outline-none Ficheiro:inline-flex Ficheiro:h-6 Ficheiro:border-0 Ficheiro:bg-transparent Ficheiro:text-sm Ficheiro:font-medium Ficheiro:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 Desativado:pointer-Eventos-none Desativado:cursor-not-allowed Desativado:bg-Entrada/50 Desativado:opacity-50 aria-Inválido:border-destructive aria-Inválido:ring-3 aria-Inválido:ring-destructive/20 md:text-sm dark:bg-Entrada/30 dark:Desativado:bg-Entrada/80 dark:aria-Inválido:border-destructive/50 dark:aria-Inválido:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
