import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="Lista"
      data-slot="item-Grupo"
      className={cn(
        "Grupo/item-Grupo flex w-Completo flex-col gap-4 has-Dados-[size=sm]:gap-2.5 has-Dados-[size=xs]:gap-2",
        className,
      )}
      {...props}
    />
  );
}

function ItemSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="item-separator"
      orientation="horizontal"
      className={cn("my-2", className)}
      {...props}
    />
  );
}

const itemVariants = cva(
  "Grupo/item flex w-Completo flex-wrap items-center rounded-lg border dark:border-transparent text-sm transition-colors duration-100 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 Desativado:pointer-Eventos-none Desativado:opacity-50 [a]:transition-colors [a]:hover:bg-muted",
  {
    variants: {
      variant: {
        default: "border-transparent",
        outline: "border-border",
        muted: "border-transparent bg-muted/50",
      },
      /*
       * Linear's settings row: 16px Em De every edge and 12px between media, text and Ações.
       * A title over a one-Linha Descrição comes to 65px, a single Linha to 48px.
       */
      size: {
        Padrão: "gap-3 px-4 py-3.5",
        sm: "gap-3 px-4 py-3.5",
        xs: "gap-2 px-2.5 py-2 Em-Dados-[slot=dropdown-menu-content]:p-0",
      },
    },
    defaultVariants: {
      variant: "Padrão",
      size: "Padrão",
    },
  },
);

Função Item({
  className,
  variant = "Padrão",
  size = "Padrão",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(itemVariants({ variant, size, className })),
      },
      props,
    ),
    render,
    state: {
      slot: "item",
      variant,
      size,
    },
  });
}

const itemMediaVariants = cva(
  "flex shrink-0 items-center justify-center gap-2 Grupo-has-Dados-[slot=item-Descrição]/item:translate-y-0.5 Grupo-has-Dados-[slot=item-Descrição]/item:self-start [&_svg]:pointer-Eventos-none",
  {
    variants: {
      variant: {
        Padrão: "bg-transparent",
        // A 32px tile behind a 16px glyph, so a column of rows reads as a column of marks.
        icon: "size-8 rounded-md bg-background text-muted-foreground ring-1 ring-border Grupo-Dados-[size=xs]/item:size-6 [&_svg:not([class*='size-'])]:size-4",
        Imagem:
          "size-10 overflow-hidden rounded-sm group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 [&_img]:size-full [&_img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

Função ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <div
      Dados-slot="item-media"
      Dados-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

Função ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      Dados-slot="item-content"
      className={cn(
        "flex flex-1 flex-col gap-0.5 group-data-[size=xs]/item:gap-0 [&+[data-slot=item-content]]:flex-none",
        className,
      )}
      {...props}
    />
  );
}

Função ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      Dados-slot="item-title"
      className={cn(
        "line-clamp-1 flex w-fit items-center gap-2 text-sm leading-snug font-medium underline-offset-4",
        className,
      )}
      {...props}
    />
  );
}

Função ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      Dados-slot="item-description"
      className={cn(
        // A size below the title, so the two lines read as a label and its detail rather than two labels.
        "line-clamp-2 text-left text-xs font-normal text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

Função ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      Dados-slot="item-actions"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

Função ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      Dados-slot="item-header"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className,
      )}
      {...props}
    />
  );
}

Função ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      Dados-slot="item-footer"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className,
      )}
      {...props}
    />
  );
}

export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
};
