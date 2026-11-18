import type { Message } from "@ag-ui/core";
import { answeredBy } from "@openbot/shared/handoff-markers";
import type { MessageReply } from "@openbot/shared/message-reply";
import { type ReactNode, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { replyChain } from "@/lib/channels/reply-chain";
import {
  BotMarkdown,
  markdownComponents,
  markdownPlugins,
  replyRemarkPlugins,
} from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { ChannelAvatar } from "./avatar";
import { MessageActions } from "./message-actions";
import { ReplyChainContext } from "./reply-chain-context";
import { TurnHoverProvider } from "./turn-hover";

export type ReplySpeaker = { author: string; botId?: string };

export function ReplyChainProvider({
  messages,
  onReply,
  children,
  speakers,
  assistant,
  resolveBotName,
}: {
  messages: readonly Message[];
  speakers?: ReadonlyMap<string, ReplySpeaker>;
  assistant?: ReplySpeaker;
  resolveBotName?: (id: string) => string | undefined;
  onReply: (reply: MessageReply) => void;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<MessageReply | null>(null);
  const chain = selected
    ? replyChain(
        messages,
        selected,
        speakers
          ? new Map(
              [...speakers].map(([id, speaker]) => [
                id,
                speaker.botId ?? speaker.author,
              ]),
            )
          : undefined,
      )
    : [];
  const identify = (reply: MessageReply): MessageReply => {
    const speaker = speakers?.get(reply.messageId);
    if (speaker) return { ...reply, ...speaker };
    const botId = answeredBy(reply.messageId);
    if (botId) {
      return {
        ...reply,
        botId,
        author: resolveBotName?.(botId) ?? reply.author ?? "Another Bot",
      };
    }
    if (assistant && (!reply.botId || reply.botId === assistant.botId)) {
      return { ...reply, ...assistant };
    }
    return reply;
  };
  return (
    <TurnHoverProvider>
      <ReplyChainContext.Provider value={{ open: setSelected, identify }}>
        {children}
        <Dialog
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <DialogContent
            className="max-w-xl gap-0 overflow-hidden p-0 shadow-sm"
            overlayClassName="bg-background/60 backdrop-blur-sm"
          >
            <DialogTitle className="sr-only">Conversation replies</DialogTitle>
            <DialogDescription className="sr-only">
              Messages connected to this reply.
            </DialogDescription>
            <div
              className="min-h-0 overflow-y-auto overscroll-contain px-6 pb-8 pt-12 sm:px-9 sm:pb-10 sm:pt-14 [@media(hover:hover)]:pb-12 sm:[@media(hover:hover)]:pb-14"
              data-slot="reply-chain"
            >
              <ol className="flex flex-col gap-3 [@media(hover:hover)]:gap-6">
                {chain.map((message) => {
                  const reply = { messageId: message.id, text: message.text };
                  const speaker =
                    message.role === "assistant"
                      ? identify(
                          selected?.messageId === message.id
                            ? { ...selected, ...reply }
                            : reply,
                        )
                      : speakers?.get(message.id);
                  const name =
                    speaker?.author ??
                    (message.role === "user" ? "You" : "Bot");
                  return (
                    <li
                      key={message.id}
                      className={cn(
                        "flex min-w-0 flex-col",
                        message.role === "user" ? "items-end" : "items-stretch",
                        message.role === "assistant" &&
                          speaker?.botId &&
                          "[&_[data-slot=message-actions]]:ms-7",
                      )}
                    >
                      <MessageActions
                        floatingToolbar
                        messageId={message.id}
                        text={message.text}
                        align={message.role === "user" ? "end" : "start"}
                        onReply={
                          message.role === "assistant"
                            ? () => {
                                setSelected(null);
                                onReply({ ...reply, ...speaker });
                              }
                            : undefined
                        }
                      >
                        {message.role === "assistant" ? (
                          <div className="flex min-w-0 items-start gap-2">
                            {speaker?.botId ? (
                              <div className="shrink-0">
                                <ChannelAvatar
                                  participantIds={[speaker.botId]}
                                  size={20}
                                />
                              </div>
                            ) : null}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-semibold leading-5 text-muted-foreground">
                                {name}
                              </p>
                              <div
                                className="min-w-0 break-words text-sm leading-relaxed [&_pre]:max-w-full [&_pre]:overflow-x-auto"
                                data-slot="thread-bot-message"
                              >
                                <BotMarkdown
                                  mode="static"
                                  components={markdownComponents}
                                  plugins={markdownPlugins}
                                  remarkPlugins={replyRemarkPlugins}
                                >
                                  {message.text}
                                </BotMarkdown>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <>
                            <span className="sr-only">{name}</span>
                            <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground">
                              <span data-message-text="">{message.text}</span>
                            </div>
                          </>
                        )}
                      </MessageActions>
                    </li>
                  );
                })}
              </ol>
            </div>
          </DialogContent>
        </Dialog>
      </ReplyChainContext.Provider>
    </TurnHoverProvider>
  );
}
