import type { MessageReply } from "@openbot/shared/message-reply";
import type { ReactNode } from "react";
import { ReplyQuote } from "./message-actions";

/** Keep the reference and response together, with a short connector rather than a full-width rail. */
export function LinkedReply({
  replies,
  children,
}: {
  replies: MessageReply[];
  children: ReactNode;
}) {
  if (!replies.length) return children;
  return (
    <div
      className="flex w-full min-w-0 flex-col items-end"
      data-slot="linked-reply"
    >
      {replies.map((reply) => (
        <ReplyQuote key={reply.messageId} reply={reply} />
      ))}
      <div className="flex w-full justify-end" data-slot="linked-reply-body">
        {children}
      </div>
    </div>
  );
}
