import type { MessageReply } from "@openbot/shared/message-reply";
import { createContext, useContext } from "react";

export const ReplyChainContext = createContext<{
  open: (reply: MessageReply) => void;
  identify: (reply: MessageReply) => MessageReply;
} | null>(null);
export function useOpenReplyChain() {
  return useContext(ReplyChainContext)?.open;
}

export function useReplyIdentity(reply: MessageReply) {
  return useContext(ReplyChainContext)?.identify(reply) ?? reply;
}
