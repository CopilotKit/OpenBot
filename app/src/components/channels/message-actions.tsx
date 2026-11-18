import type { MessageReply } from "@openbot/shared/message-reply";
import {
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconCornerUpLeft,
  IconDots,
  IconX,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { ChannelAvatar } from "./avatar";
import { useOpenReplyChain, useReplyIdentity } from "./reply-chain-context";
import { plainWords } from "./transcript-turns";
import { useTurnHover } from "./turn-hover";

export function ReplyQuote({
  reply,
  onCancel,
  connector = true,
}: {
  reply: MessageReply;
  onCancel?: () => void;
  connector?: boolean;
}) {
  const openChain = useOpenReplyChain();
  const identity = useReplyIdentity(reply);
  if (!onCancel)
    return (
      <div
        data-slot="message-reply"
        className={
          connector
            ? "relative mb-3 ml-auto mr-1 w-fit max-w-[min(22rem,90%)] self-end"
            : "relative ml-auto mr-1 w-fit max-w-[min(22rem,90%)] self-end"
        }
      >
        <button
          type="button"
          onClick={() => openChain?.(identity)}
          aria-label="View reply thread"
          className="group/reply-preview block max-w-full cursor-pointer rounded-xl border border-border/55 bg-muted/35 px-3 py-2 text-left text-muted-foreground transition-colors hover:border-primary/30 hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        >
          <span className="mb-1 flex min-w-0 items-center gap-1.5 text-xs font-medium leading-4">
            {identity.botId ? (
              <ChannelAvatar participantIds={[identity.botId]} size={16} />
            ) : (
              <IconCornerUpLeft className="size-3 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {identity.author ?? "Bot"}
            </span>
            <IconChevronRight className="size-3 shrink-0 opacity-50 group-hover/reply-preview:opacity-100" />
          </span>
          <span className="line-clamp-2 break-words text-sm leading-5">
            {plainWords(reply.text)}
          </span>
        </button>
        {connector ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-full h-3 w-3 rounded-br-lg border-r border-border/70"
          />
        ) : null}
      </div>
    );
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-sm"
      data-slot="message-reply"
    >
      <div className="min-w-0 flex-1 border-l-2 border-primary/50 pl-2.5">
        <p className="mb-0.5 text-xs font-medium leading-4 text-muted-foreground">
          Replying to {identity.author ?? "Bot"}
        </p>
        <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5">
          {plainWords(reply.text)}
        </p>
      </div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Cancel reply"
        onClick={onCancel}
      >
        <IconX className="size-4" />
      </Button>
    </div>
  );
}

/** Native selection stays available; actions are reachable on hover, focus and touch. */
export function MessageActions({
  messageId,
  text,
  onReply,
  onCopied,
  children,
  disabled = false,
  showToolbar = true,
  turnId,
  align = "start",
  floatingToolbar = false,
}: {
  align?: "start" | "end";
  floatingToolbar?: boolean;
  turnId?: string;
  showToolbar?: boolean;
  disabled?: boolean;
  messageId: string;
  text: string;
  onReply?: (reply: MessageReply) => void;
  onCopied?: () => void;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const hover = useTurnHover();
  const hoverId = turnId ?? messageId;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onCopied?.();
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
      toast.add({
        type: "error",
        title: "Couldn't copy this message",
        description: "Try selecting the text and copying it.",
      });
    }
  };
  const identity = useReplyIdentity({ messageId, text });
  const reply = () => onReply?.(identity);
  if (disabled) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        className={cn(
          "group/message-actions relative min-w-0 cursor-pointer select-text",
          "[&_:where(p,li,blockquote,pre,code,th,td,h1,h2,h3,h4,h5,h6,[data-message-text])]:cursor-text",
          "[&_:where(p,h1,h2,h3,h4,h5,h6)]:max-w-fit",
          "[&_:where(a[href],button:not(:disabled))]:cursor-pointer",
          align === "end" && "max-w-[85%]",
        )}
        render={<div />}
        onPointerEnter={() => {
          if (showToolbar || turnId) hover?.setActive(hoverId);
        }}
        onPointerLeave={() => {
          if (showToolbar || turnId) hover?.setActive(null);
        }}
      >
        {children}
        {showToolbar ? (
          <div
            className={cn(
              "mt-1 flex items-center gap-1 text-muted-foreground opacity-100 transition-opacity data-[align=end]:justify-end sm:opacity-0 sm:group-hover/message-actions:opacity-100 sm:group-hover/agent-turn:opacity-100 sm:data-[turn-hovered=true]:opacity-100 sm:group-focus-within/message-actions:opacity-100 [@media(hover:none)]:opacity-100",
              floatingToolbar &&
                "[@media(hover:hover)]:absolute [@media(hover:hover)]:top-full [@media(hover:hover)]:z-10 [@media(hover:hover)]:mt-0 [@media(hover:hover)]:w-max [@media(hover:hover)]:data-[align=end]:end-0 [@media(hover:hover)]:data-[align=start]:start-0 [&>button]:size-6",
            )}
            data-slot="message-actions"
            data-align={align}
            data-turn-hovered={hover?.active === hoverId}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={copied ? "Copied message" : "Copy message"}
              onClick={() => void copy()}
              onPointerLeave={() => setCopied(false)}
            >
              {copied ? (
                <IconCheck className="size-4" />
              ) : (
                <IconCopy className="size-4" />
              )}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Message actions"
                  />
                }
              >
                <IconDots className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align={align} className="min-w-40">
                {onReply ? (
                  <DropdownMenuItem onClick={reply}>
                    <IconCornerUpLeft className="size-4" />
                    Reply
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onClick={() => void copy()}>
                  <IconCopy className="size-4" />
                  Copy
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        {onReply ? (
          <ContextMenuItem onClick={reply}>
            <IconCornerUpLeft className="size-4" />
            Reply
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onClick={() => void copy()}>
          <IconCopy className="size-4" />
          Copy
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
