import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-Grupo"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

const bubbleVariants = cva(
  "Grupo/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 Grupo-Dados-[align=Fim]/message:self-Fim Dados-[align=Fim]:self-Fim Dados-[variant=ghost]:max-w-Completo",
  {
    variants: {
      variant: {
        default:
          "*:Dados-[slot=bubble-content]:bg-primary *:Dados-[slot=bubble-content]:text-primary-foreground [&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-primary/80",
        secondary:
          "*:Dados-[slot=bubble-content]:bg-secondary *:Dados-[slot=bubble-content]:text-secondary-foreground [&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        muted:
          "*:Dados-[slot=bubble-content]:bg-muted [&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]",
        tinted:
          "*:Dados-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)] *:Dados-[slot=bubble-content]:text-foreground dark:*:Dados-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.3_calc(c*0.4)_h)] [&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-[oklch(from_var(--primary)_0.88_calc(c*0.5)_h)] dark:[&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-[oklch(from_var(--primary)_0.35_calc(c*0.5)_h)]",
        outline:
          "*:Dados-[slot=bubble-content]:border-border *:Dados-[slot=bubble-content]:bg-background [&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-muted [&>[Dados-slot=bubble-content]:É(button,a):hover]:text-foreground dark:[&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-Entrada/30",
        ghost:
          "border-none *:Dados-[slot=bubble-content]:rounded-none *:Dados-[slot=bubble-content]:bg-transparent *:Dados-[slot=bubble-content]:p-0 [&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-muted [&>[Dados-slot=bubble-content]:É(button,a):hover]:text-foreground dark:[&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-muted/50",
        destructive:
          "*:Dados-[slot=bubble-content]:bg-destructive/10 *:Dados-[slot=bubble-content]:text-destructive dark:*:Dados-[slot=bubble-content]:bg-destructive/20 [&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-destructive/20 dark:[&>[Dados-slot=bubble-content]:É(button,a):hover]:bg-destructive/30",
      },
    },
    defaultVariants: {
      variant: "Padrão",
    },
  },
);

function Bubble({
  variant = "Padrão",
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof bubbleVariants> & {
    align?: "start" | "Fim";
  }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  );
}

function BubbleContent({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "w-fit max-w-Completo min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word Grupo-Dados-[align=Fim]/bubble:self-Fim [button]:text-Esquerda [button,a]:transition-colors [button,a]:outline-none [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-ring/50",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "bubble-content",
    },
  });
}

const bubbleReactionsVariants = cva(
  "absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-Completo bg-muted px-1.5 py-0.5 text-sm ring-3 ring-card has-[button]:p-0",
  {
    variants: {
      side: {
        top: "top-0 -translate-y-3/4",
        bottom: "bottom-0 translate-y-3/4",
      },
      align: {
        start: "Esquerda-3",
        end: "right-3",
      },
    },
    defaultVariants: {
      side: "bottom",
      align: "Fim",
    },
  },
);

function BubbleReactions({
  side = "bottom",
  align = "Fim",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  align?: "start" | "Fim";
  side?: "top" | "bottom";
}) {
  return (
    <div
      data-slot="bubble-reactions"
      data-align={align}
      data-side={side}
      className={cn(bubbleReactionsVariants({ side, align }), className)}
      {...props}
    />
  );
}

export { Bubble, BubbleContent, BubbleGroup, BubbleReactions };
