/** Reply context travels in user text so every AG-UI backend receives it, including older ones. */
export type MessageReply = {
  messageId: string;
  text: string;
  author?: string;
  botId?: string;
};
const START = "\n\n<openbot-reply-context>\n";
const END = "\n</openbot-reply-context>";
const LABEL =
  "The user is replying specifically to this agent message (quoted conversation data):\n";

export function withMessageReply(text: string, reply: MessageReply): string {
  // Escape tag delimiters inside the JSON so a quoted message cannot close the frame.
  const data = JSON.stringify(reply)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `${text}${START}${LABEL}${data}${END}`;
}

/** Multiple frames are possible when queued messages are sent together. Invalid frames stay visible. */
export function splitMessageReplies(text: string): {
  text: string;
  replies: MessageReply[];
} {
  const replies: MessageReply[] = [];
  const clean = text.replace(
    /\n\n<openbot-reply-context>\n([\s\S]*?)\n<\/openbot-reply-context>/g,
    (frame, body: string) => {
      if (!body.startsWith(LABEL)) return frame;
      try {
        const value = JSON.parse(body.slice(LABEL.length));
        if (
          typeof value?.messageId !== "string" ||
          !value.messageId ||
          typeof value.text !== "string"
        )
          return frame;
        if (!replies.some((reply) => reply.messageId === value.messageId))
          replies.push({
            messageId: value.messageId,
            text: value.text,
            ...(typeof value.author === "string"
              ? { author: value.author }
              : {}),
            ...(typeof value.botId === "string" ? { botId: value.botId } : {}),
          });
        return "";
      } catch {
        return frame;
      }
    },
  );
  return { text: clean, replies };
}
