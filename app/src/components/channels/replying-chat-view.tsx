import {
  type CopilotChatInputProps,
  CopilotChatUserMessage,
  type CopilotChatUserMessageProps,
  CopilotChatView,
  CopilotChatInput as CopilotChatViewInput,
  type CopilotChatViewProps,
} from "@copilotkit/react-core/v2";
import {
  type MessageReply,
  splitMessageReplies,
  withMessageReply,
} from "@openbot/shared/message-reply";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { LinkedReply } from "./linked-reply";
import { ReplyQuote } from "./message-actions";
import { ReplyChainProvider, type ReplySpeaker } from "./reply-chain";

export const DirectReplySpeaker = createContext<ReplySpeaker | undefined>(
  undefined,
);

const ReplyContext = createContext<
  | {
      choose: (reply: MessageReply) => void;
      selected: MessageReply | null;
      cancel: () => void;
    }
  | undefined
>(undefined);
export function useReplyToMessage() {
  return useContext(ReplyContext)?.choose;
}

// A stable slot component keeps the editor mounted while its controlled value changes.
function ReplyInput(props: CopilotChatInputProps) {
  const reply = useContext(ReplyContext);
  return (
    <div>
      {reply?.selected ? (
        <div className="mx-auto mb-2 max-w-3xl px-4">
          <ReplyQuote reply={reply.selected} onCancel={reply.cancel} />
        </div>
      ) : null}
      <CopilotChatViewInput {...props} />
    </div>
  );
}

function ReplyUserMessage(props: CopilotChatUserMessageProps) {
  const replies: MessageReply[] = [];
  const strip = (text: string) => {
    const split = splitMessageReplies(text);
    replies.push(...split.replies);
    return split.text;
  };
  const content =
    typeof props.message.content === "string"
      ? strip(props.message.content)
      : props.message.content.map((part) =>
          part.type === "text" ? { ...part, text: strip(part.text) } : part,
        );
  return (
    <LinkedReply replies={replies}>
      <CopilotChatUserMessage
        {...props}
        message={{ ...props.message, content }}
      />
    </LinkedReply>
  );
}

const ReplyUserMessageSlot = Object.assign(
  ReplyUserMessage,
  CopilotChatUserMessage,
);

/** Intercept the SDK's normal submit path, retaining its attachments, thread and run handling. */
export function ReplyingChatView(props: CopilotChatViewProps) {
  const assistant = useContext(DirectReplySpeaker);
  const [replyTo, setReplyTo] = useState<MessageReply | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const chooseReply = useCallback((reply: MessageReply) => {
    setReplyTo(reply);
    setTimeout(
      () =>
        container.current
          ?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
          ?.focus(),
      0,
    );
  }, []);
  return (
    <ReplyContext.Provider
      value={{
        choose: chooseReply,
        selected: replyTo,
        cancel: () => setReplyTo(null),
      }}
    >
      <ReplyChainProvider
        messages={props.messages ?? []}
        assistant={assistant}
        onReply={chooseReply}
      >
        <div ref={container} className="h-full min-h-0">
          <CopilotChatView
            {...props}
            messageView={{
              ...(typeof props.messageView === "object"
                ? props.messageView
                : {}),
              userMessage: ReplyUserMessageSlot,
            }}
            input={ReplyInput}
            onSubmitMessage={
              props.onSubmitMessage
                ? (text) => {
                    props.onSubmitMessage?.(
                      replyTo ? withMessageReply(text, replyTo) : text,
                    );
                    setReplyTo(null);
                  }
                : undefined
            }
          />
        </div>
      </ReplyChainProvider>
    </ReplyContext.Provider>
  );
}
