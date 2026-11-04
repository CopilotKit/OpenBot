import type { Message } from "@ag-ui/core";
import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BotOrb } from "@/components/agents/bot-orb";
import { Button } from "@/components/ui/button";
import {
  type ApprovalInboxData,
  approvalInboxOptions,
  dismissPersonQuestionMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";

export type WaitingQuestion = ApprovalInboxData["questions"][number];

/**
 * The question this conversation's Bot is waiting on, if one is: the newest open question asked in
 * this conversation. While there is one, what the person sends here is their answer to it.
 */
export function useConversationQuestion(
  channelId: string,
  threadId: string,
): WaitingQuestion | undefined {
  const inbox = useQuery(approvalInboxOptions());
  return inbox.data?.questions.find(
    (question) =>
      question.channelId === channelId && question.threadId === threadId,
  );
}

/**
 * The id the server stores an answer under, and the message it is stored as: see
 * `person-response-sweep.ts` and `questionResponseMessage` in server/src/approvals/questions.ts.
 * Drawn here under the same id, so the stored copy read back later replaces this one.
 */
const ANSWER_PREFIX = "person-response:";
const ANSWER_LEAD = "In response to your question: ";

export function answerMessage(
  question: WaitingQuestion,
  response: string,
): Message {
  return {
    id: `${ANSWER_PREFIX}${question.id}`,
    role: "user",
    content: `${ANSWER_LEAD}${question.question}\n\n${response}`,
  };
}

/**
 * An answer as the person reads it: only what they wrote. The question it quotes is for the Bot,
 * and is already on screen right above it as the step where the Bot asked.
 */
export function shownAnswer(message: Message): Message {
  if (
    message.role !== "user" ||
    !message.id.startsWith(ANSWER_PREFIX) ||
    typeof message.content !== "string" ||
    !message.content.startsWith(ANSWER_LEAD)
  )
    return message;
  const split = message.content.indexOf("\n\n");
  return split === -1
    ? message
    : { ...message, content: message.content.slice(split + 2) };
}

/**
 * The composer's drawer while the Bot waits on the person: what it asked and why, so the answer is
 * written with the question in view however far the conversation has scrolled. A long question
 * scrolls inside the drawer rather than pushing the conversation away. Sending answers it; Dismiss
 * puts it down with nothing sent.
 */
export function QuestionNotice({
  question,
  botName,
  avatarSeed,
}: {
  question: WaitingQuestion;
  botName: string;
  avatarSeed: string;
}) {
  const dismiss = useMutation(
    dismissPersonQuestionMutationOptions(queryClient),
  );
  return (
    <section
      aria-label={`${botName} is waiting on your answer`}
      className="flex gap-2.5 px-3 pt-2.5 pb-2"
    >
      <BotOrb name={botName} seed={avatarSeed} size={20} />
      <div className="flex max-h-36 min-w-0 flex-1 flex-col gap-1 overflow-y-auto">
        <p className="text-muted-foreground text-xs">
          <span className="font-medium text-foreground">{botName}</span> is
          waiting on your answer
        </p>
        <p className="whitespace-pre-wrap text-sm leading-snug">
          {question.question}
        </p>
        {question.why ? (
          <p className="whitespace-pre-wrap text-muted-foreground text-sm">
            {question.why}
          </p>
        ) : null}
        {dismiss.error ? (
          <p className="text-destructive text-sm" role="alert">
            {dismiss.error.message}
          </p>
        ) : null}
      </div>
      <Button
        aria-label="Dismiss question"
        className="-mt-1 -mr-1"
        disabled={dismiss.isPending}
        onClick={() => dismiss.mutate({ id: question.id })}
        size="icon-sm"
        title="Dismiss without answering"
        variant="ghost"
      >
        <IconX />
      </Button>
    </section>
  );
}
