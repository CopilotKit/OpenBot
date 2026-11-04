import type { Message } from "@ag-ui/core";
import { IconChevronLeft, IconX } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { Button } from "@/components/ui/button";
import {
  type ApprovalInboxData,
  approvalInboxOptions,
  dismissPersonQuestionMutationOptions,
} from "@/lib/approvals";
import { cn } from "@/lib/utils";
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

/** The separate decisions inside a question, answered one at a time. */
export type QuestionSteps = {
  /** Which decision is being answered, from 0; past the last once all are answered. */
  index: number;
  /** The decision being answered, or undefined for a question asked whole. */
  current: NonNullable<WaitingQuestion["parts"]>[number] | undefined;
  /** What the person picked or wrote for each decision so far. */
  answers: readonly string[];
  /**
   * Answer the current decision and move to the next. Returns the whole answer, every decision on a
   * line of its own under its label, once the last one is answered; null until then.
   */
  answer: (text: string) => string | null;
  back: () => void;
};

/**
 * Walks a question's decisions one at a time, as T3 Code and Claude Code walk theirs: a pick or a
 * typed answer settles one and shows the next, and the last one sends them all as one answer. Starts
 * over when the question changes.
 */
export function useQuestionSteps(
  question: WaitingQuestion | undefined,
): QuestionSteps {
  const parts = question?.parts ?? [];
  const [state, setState] = useState<{
    id: string | undefined;
    index: number;
    answers: string[];
  }>({ id: question?.id, index: 0, answers: [] });
  const current =
    state.id === question?.id
      ? state
      : { id: question?.id, index: 0, answers: [] };
  if (current !== state) setState(current);
  return {
    index: current.index,
    current: parts[current.index],
    answers: current.answers,
    answer: (text) => {
      const answers = [...current.answers];
      answers[current.index] = text.trim();
      setState({ ...current, index: current.index + 1, answers });
      return current.index + 1 < parts.length
        ? null
        : parts
            .map((part, index) => `${part.header}: ${answers[index]}`)
            .join("\n");
    },
    back: () => setState({ ...current, index: Math.max(0, current.index - 1) }),
  };
}

/** Whether a key press is typing into a field, which a number shortcut must leave alone. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/**
 * The composer's drawer while the Bot waits on the person: what it asked and why, so the answer is
 * written with the question in view however far the conversation has scrolled. A long question
 * scrolls inside the drawer rather than pushing the conversation away. Dismiss puts it down with
 * nothing sent.
 *
 * A question of several decisions shows one at a time, with its options as a list: picking one, or
 * pressing its number, answers it, and typing in the composer answers it in the person's own words.
 * A question asked whole is answered by sending from the composer.
 */
export function QuestionNotice({
  question,
  botName,
  avatarSeed,
  steps,
  onAnswered,
}: {
  question: WaitingQuestion;
  botName: string;
  avatarSeed: string;
  steps: QuestionSteps;
  /** Every decision has an answer: send them. */
  onAnswered: (answer: string) => void;
}) {
  const dismiss = useMutation(
    dismissPersonQuestionMutationOptions(queryClient),
  );
  const total = question.parts?.length ?? 0;
  const part = steps.current;
  const [picked, setPicked] = useState<string | null>(null);
  const pick = (option: string) => {
    setPicked(option);
    // A beat to see the pick land before the next decision replaces it.
    window.setTimeout(() => {
      setPicked(null);
      const whole = steps.answer(option);
      if (whole !== null) onAnswered(whole);
    }, 200);
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const options = part?.options;
  useEffect(() => {
    if (!options) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        typing(event.target)
      )
        return;
      const option = options[Number.parseInt(event.key, 10) - 1];
      if (!option) return;
      event.preventDefault();
      pickRef.current(option);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [options]);

  return (
    <section
      aria-label={`${botName} is waiting on your answer`}
      className="flex gap-2.5 px-3 pt-2.5 pb-2"
    >
      <BotOrb name={botName} seed={avatarSeed} size={20} />
      <div className="flex max-h-56 min-w-0 flex-1 flex-col gap-1 overflow-y-auto">
        <p className="flex min-h-5 items-center gap-1.5 text-muted-foreground text-xs">
          <span className="font-medium text-foreground">{botName}</span>
          {part ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{part.header}</span>
            </>
          ) : (
            <span>is waiting on your answer</span>
          )}
        </p>
        <p className="whitespace-pre-wrap text-sm leading-snug">
          {part ? part.question : question.question}
        </p>
        {!part && question.why ? (
          <p className="whitespace-pre-wrap text-muted-foreground text-sm">
            {question.why}
          </p>
        ) : null}
        {part?.options ? (
          <div className="-ml-1.5 mt-1 flex flex-col">
            {part.options.map((option, index) => {
              const chosen =
                picked === option ||
                (picked === null && steps.answers[steps.index] === option);
              return (
                <button
                  aria-pressed={chosen}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-background",
                    chosen ? "text-foreground" : "text-foreground/80",
                  )}
                  disabled={picked !== null}
                  key={option}
                  onClick={() => pick(option)}
                  type="button"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-card",
                      chosen && "border-primary bg-primary",
                    )}
                  >
                    {chosen ? (
                      <span className="size-1.5 rounded-full bg-primary-foreground" />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">{option}</span>
                  {index < 9 ? (
                    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border bg-card px-1 font-sans text-[11px] text-muted-foreground leading-none">
                      {index + 1}
                    </kbd>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {part ? (
          <p className="text-muted-foreground text-xs">
            {part.options ? "Pick one, or type" : "Type"} your answer below.
          </p>
        ) : null}
        {dismiss.error ? (
          <p className="text-destructive text-sm" role="alert">
            {dismiss.error.message}
          </p>
        ) : null}
      </div>
      <div className="-mt-1 -mr-1 flex h-fit items-center gap-0.5">
        {total > 1 && part ? (
          <>
            <Button
              aria-label="Previous decision"
              disabled={steps.index === 0}
              onClick={steps.back}
              size="icon-sm"
              variant="ghost"
            >
              <IconChevronLeft />
            </Button>
            <span className="px-0.5 text-muted-foreground text-xs tabular-nums">
              {steps.index + 1}/{total}
            </span>
          </>
        ) : null}
        <Button
          aria-label="Dismiss question"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate({ id: question.id })}
          size="icon-sm"
          title="Dismiss without answering"
          variant="ghost"
        >
          <IconX />
        </Button>
      </div>
    </section>
  );
}
