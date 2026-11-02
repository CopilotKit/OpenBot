/** References supplied by a task reply. Instructions and file bytes are resolved by the server. */
export type TaskReplyContext = {
  attachmentIds?: string[];
  skillIds?: string[];
};

export type DurableTaskReply = TaskReplyContext & {
  reply: string;
  messageId: string;
};
