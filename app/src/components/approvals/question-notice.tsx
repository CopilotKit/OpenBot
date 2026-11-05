import type { Message } from "@ag-ui/core";
import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { Button } from "@/components/ui/button";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
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

type QuestionPart = NonNullable<WaitingQuestion["parts"]>[number];

/** The form field a decision's answer is posted under. */
const fieldOf = (index: number) => `part-${index}`;

/**
 * The whole answer to a question of several decisions, each on a line of its own under its label:
 * the option picked, what was typed in its own words, or both.
 */
export function partsAnswer(parts: readonly QuestionPart[], form: FormData) {
  return parts
    .map((part, index) => {
      const given = form
        .getAll(fieldOf(index))
        .map((value) => String(value).trim())
        .filter(Boolean);
      return `${part.header}: ${given.join(", ")}`;
    })
    .join("\n");
}

/**
 * A question asked in parts as a questionnaire: one decision at a time, its options as a numbered
 * list with a field for an answer in the person's own words, and Send on the last. What is sent is
 * one answer, a line per decision.
 *
 * One decision is a questionnaire of one, and reads as a single question: no "Question 1 of 1",
 * and one answer to send rather than answers.
 */
function QuestionParts({
  parts,
  onAnswered,
}: {
  parts: readonly QuestionPart[];
  onAnswered: (answer: string) => Promise<void>;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const several = parts.length > 1;
  return (
    <Questionnaire
      className="mt-1 gap-3"
      items={parts.map((part, index) => ({
        name: fieldOf(index),
        required: true,
        choices: part.options?.map((value) => ({ value })),
      }))}
      onSubmit={(event) => {
        event.preventDefault();
        setSending(true);
        setError(null);
        onAnswered(partsAnswer(parts, new FormData(event.currentTarget)))
          .catch((failure: Error) => setError(failure.message))
          .finally(() => setSending(false));
      }}
      shortcuts="numbers"
    >
      {parts.map((part, index) => (
        <QuestionnaireItem
          className="gap-2"
          key={fieldOf(index)}
          name={fieldOf(index)}
          required
        >
          <QuestionnaireTitle className="mb-0 font-normal text-sm">
            <span className="font-medium">{part.header}:</span> {part.question}
          </QuestionnaireTitle>
          {part.options ? (
            <QuestionnaireChoices className="gap-1.5">
              {part.options.map((option) => (
                <QuestionnaireChoice
                  className="min-h-9 bg-card py-2 hover:bg-card data-checked:bg-card dark:bg-card"
                  key={option}
                  value={option}
                >
                  {option}
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
          ) : null}
          <QuestionnaireInput
            aria-label={`${part.header}, in your own words`}
            className="min-h-9 bg-card dark:bg-card"
            placeholder={
              part.options ? "Or answer in your own words" : "Your answer"
            }
          />
          <QuestionnaireError />
        </QuestionnaireItem>
      ))}
      <QuestionnaireActions className="min-h-8">
        <QuestionnairePrevious size="sm" variant="ghost">
          Back
        </QuestionnairePrevious>
        {several ? (
          <QuestionnaireProgress className="col-start-2 row-start-1 justify-self-end" />
        ) : null}
        <QuestionnaireNext size="sm">Next</QuestionnaireNext>
        <QuestionnaireSubmit disabled={sending} size="sm">
          {sending ? "Sending…" : several ? "Send answers" : "Send answer"}
        </QuestionnaireSubmit>
      </QuestionnaireActions>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </Questionnaire>
  );
}

/**
 * The composer's drawer while the Bot waits on the person: what it asked and why, so the answer is
 * written with the question in view however far the conversation has scrolled. Dismiss puts it down
 * with nothing sent.
 *
 * A question asked whole is answered by sending from the composer. A question asked in parts, one
 * or several, is answered in the drawer, one decision at a time; a reply sent from the composer
 * instead answers it whole, in the person's own words.
 */
export function QuestionNotice({
  question,
  botName,
  avatarSeed,
  onAnswered,
}: {
  question: WaitingQuestion;
  botName: string;
  avatarSeed: string;
  onAnswered: (answer: string) => Promise<void>;
}) {
  const dismiss = useMutation(
    dismissPersonQuestionMutationOptions(queryClient),
  );
  const parts = question.parts?.length ? question.parts : undefined;
  return (
    <section
      aria-label={`${botName} is waiting on your answer`}
      className="flex gap-2.5 px-3 pt-2.5 pb-2"
    >
      <BotOrb name={botName} seed={avatarSeed} size={20} />
      <div className="flex max-h-80 min-w-0 flex-1 flex-col gap-1 overflow-y-auto">
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
        {parts ? <QuestionParts onAnswered={onAnswered} parts={parts} /> : null}
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
