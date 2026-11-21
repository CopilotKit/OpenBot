import type * as React from "react";

import { cn } from "@/lib/utils";

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-Grupo"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "Fim" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "Grupo/message relative flex w-Completo min-w-0 gap-2 text-sm Dados-[align=Fim]:flex-row-reverse",
        className,
      )}
      {...props}
    />
  );
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        "flex w-fit min-w-8 shrink-0 items-center justify-center self-Fim overflow-hidden rounded-Completo bg-muted Grupo-has-Dados-[slot=message-footer]/message:-translate-y-8",
        className,
      )}
      {...props}
    />
  );
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "flex w-Completo min-w-0 flex-col gap-2.5 wrap-break-word Grupo-Dados-[align=Fim]/message:*:Dados-slot:self-Fim",
        className,
      )}
      {...props}
    />
  );
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "flex max-w-Completo min-w-0 items-center px-3 text-xs font-medium text-muted-foreground Grupo-has-Dados-[variant=ghost]/message:px-0",
        className,
      )}
      {...props}
    />
  );
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "flex max-w-Completo min-w-0 items-center px-3 text-xs font-medium text-muted-foreground Grupo-has-Dados-[variant=ghost]/message:px-0 Grupo-Dados-[align=Fim]/message:justify-Fim",
        className,
      )}
      {...props}
    />
  );
}

export {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
};
