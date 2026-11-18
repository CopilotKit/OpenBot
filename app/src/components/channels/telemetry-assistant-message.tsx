import {
  CopilotChatAssistantMessage,
  type CopilotChatAssistantMessageProps,
  useCopilotChatConfiguration,
} from "@copilotkit/react-core/v2";
import { type ComponentProps, createContext, useContext } from "react";
import { assistantTurn } from "@/lib/channels/assistant-turn";
import {
  type ResultReference,
  recordResultAction,
  useResultVisibility,
} from "@/lib/product-telemetry";
import { MessageActions } from "./message-actions";
import { useReplyToMessage } from "./replying-chat-view";

const ResultContext = createContext<{
  reference?: ResultReference;
  settled: boolean;
}>({ settled: false });

/** Observe the actual markdown body; a toolbar or an empty tool shell is not a viewed answer. */
function ResultMarkdownRenderer(
  props: ComponentProps<typeof CopilotChatAssistantMessage.MarkdownRenderer>,
) {
  const { reference, settled } = useContext(ResultContext);
  const ref = useResultVisibility(
    reference,
    settled && props.content.trim().length > 0,
  );
  return (
    <div ref={ref}>
      <CopilotChatAssistantMessage.MarkdownRenderer {...props} />
    </div>
  );
}

/** The packaged direct Bot chat shares the same condition as OpenBot's channel transcript. */
function ResultAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const onReply = useReplyToMessage();
  const configuration = useCopilotChatConfiguration();
  const threadId = configuration?.threadId;
  const reference = threadId
    ? { threadId, messageId: props.message.id }
    : undefined;
  const index =
    props.messages?.findIndex((message) => message.id === props.message.id) ??
    -1;
  // Earlier turns remain observable during a new run. Every answer in the current turn waits for
  // the run to settle, including prose preceding a tool call rather than just the last message.
  const settled =
    !props.isRunning ||
    (index >= 0 &&
      Boolean(
        props.messages
          ?.slice(index + 1)
          .some((message) => message.role === "user"),
      ));
  const turn = assistantTurn(
    props.messages ?? [props.message],
    props.message.id,
  );
  const ownsToolbar = turn?.messageId === props.message.id;
  return (
    <ResultContext.Provider value={{ reference, settled }}>
      <MessageActions
        messageId={props.message.id}
        text={turn?.text ?? props.message.content ?? ""}
        onReply={onReply}
        disabled={!settled || !turn?.text.trim()}
        showToolbar={ownsToolbar}
        turnId={turn?.messageId}
        onCopied={() => {
          if (reference) void recordResultAction("result_copied", reference);
        }}
      >
        <CopilotChatAssistantMessage
          {...props}
          copyButton={() => null}
          markdownRenderer={props.markdownRenderer ?? ResultMarkdownRenderer}
        />
      </MessageActions>
    </ResultContext.Provider>
  );
}

// The SDK slot type includes its static subcomponents, which callers may also customize.
export const TelemetryAssistantMessage = Object.assign(
  ResultAssistantMessage,
  CopilotChatAssistantMessage,
);
