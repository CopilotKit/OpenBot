import { IconMessageQuestion } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { NeedsYouRows, useNeedsYou } from "@/components/needs-you/needs-you";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { ApprovalCard } from "./approval-card";

type WaitingQuestion = ApprovalInboxData["questions"][number];
type WaitingRequest = ApprovalInboxData["requests"][number];

/**
 * What waits on the person in the approval inbox, for one Bot or for all of them: the questions its
 * Bots asked, and the actions waiting on a decision. A question asked during a hand-off belongs to
 * the Bot whose conversation it is.
 */
function useWaiting(
  agentId: string | undefined,
  decidedHere: ReadonlySet<string> = new Set(),
) {
  const inbox = useQuery(approvalInboxOptions());
  const ours = (botId: string) => agentId === undefined || botId === agentId;
  return {
    error: inbox.error,
    questions: (inbox.data?.questions ?? []).filter((question) =>
      ours(question.conversationBotId ?? question.botId),
    ),
    // One answered here stays, folded to how it went, until the page is left.
    pending: (inbox.data?.requests ?? []).filter(
      (request) =>
        (request.status === "pending" || decidedHere.has(request.id)) &&
        ours(request.action.botId),
    ),
  };
}

/** A question a Bot asked mid-run, answered on the row's own footer line. */
function QuestionRow({
  question,
  botName,
}: {
  question: WaitingQuestion;
  botName: string;
}) {
  const [text, setText] = useState("");
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconMessageQuestion />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none">
          {botName} asks: {question.question}
        </ItemTitle>
        {question.why ? (
          <ItemDescription className="line-clamp-none">
            {question.why}
          </ItemDescription>
        ) : null}
      </ItemContent>
      {/* In from the edge by the icon and its gap, so the answer lines up with the question. */}
      <ItemFooter className="flex-col items-start pl-11">
        <Textarea
          aria-label="Your answer"
          onChange={(event) => setText(event.target.value)}
          placeholder="Your answer"
          value={text}
        />
        <Button
          disabled={answer.isPending || !text.trim()}
          onClick={() => answer.mutate({ id: question.id, response: text })}
          size="sm"
        >
          Send answer
        </Button>
        {answer.error ? (
          <p role="alert" className="text-sm text-destructive">
            {answer.error.message}
          </p>
        ) : null}
      </ItemFooter>
    </Item>
  );
}

/**
 * An action waiting on a decision: the same approval card the conversation draws, framed as a row
 * of the list, so a decision made in either place is the one decision.
 */
function RequestRow({
  request,
  botName,
  onDecided,
}: {
  request: WaitingRequest;
  botName: string;
  /** Told before the decision is sent, so the row stays, folded, once it is answered. */
  onDecided: (id: string) => void;
}) {
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  return (
    <ApprovalCard
      botName={botName}
      busy={decision.isPending}
      error={decision.error?.message ?? null}
      frame="row"
      onDecide={(choice) => {
        onDecided(request.id);
        decision.mutate({ id: request.id, choice });
      }}
      request={request}
    />
  );
}

/** The waiting questions and actions as rows, questions first, for a card that may hold more. */
export function useWaitingRows(agentId: string | undefined) {
  const [decidedHere, setDecidedHere] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const waiting = useWaiting(agentId, decidedHere);
  const decided = (id: string) =>
    setDecidedHere((prior) => new Set(prior).add(id));
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
  return {
    error: waiting.error,
    rows: [
      ...waiting.questions.map((question) => (
        <QuestionRow
          botName={botName(question.botId)}
          key={`question-${question.id}`}
          question={question}
        />
      )),
      ...waiting.pending.map((request) => (
        <RequestRow
          botName={botName(request.action.botId)}
          key={`request-${request.id}`}
          onDecided={decided}
          request={request}
        />
      )),
    ],
  };
}

/**
 * Questions and actions waiting on the person, one row each, decided where it is shown: a question's
 * answer box sits on its row's footer line, and an action is the same approval card the
 * conversation draws, so a decision made in either place is the one decision. An action answered
 * here stays, folded to how it went, until the page is left. Given a Bot, only that Bot's.
 */
export function WaitingForYou({ agentId }: { agentId?: string }) {
  const { error, rows } = useWaitingRows(agentId);
  return (
    <>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <PageRows>
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {index > 0 ? <Separator /> : null}
              {row}
            </Fragment>
          ))}
        </PageRows>
      ) : null}
    </>
  );
}

/**
 * Everything one Bot is waiting on the person for, at the top of its page, in one card: its
 * questions and the actions waiting on a decision, then the tasks started from its check-ins, then
 * what its check-ins found, with Start and Hide. Nothing is drawn when nothing waits: the sidebar's
 * badge already said whether to look.
 */
export function BotNeedsYou({ agentId }: { agentId: string }) {
  const waiting = useWaitingRows(agentId);
  const list = useNeedsYou(agentId);
  if (
    waiting.rows.length + list.tasks.length + list.items.length === 0 &&
    !waiting.error &&
    !list.error
  )
    return null;
  return (
    <PageSection title="Needs you">
      {waiting.error || list.error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {(waiting.error ?? list.error)?.message}
        </p>
      ) : null}
      <NeedsYouRows items={list.items} lead={waiting.rows} tasks={list.tasks} />
    </PageSection>
  );
}
