import { IconMessageQuestion } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { ApprovalCard } from "./approval-card";

/**
 * Questions and actions waiting on the person, one row each, decided where it is shown: a question's
 * answer box sits on its row's footer line, and an action is the same approval card the
 * conversation draws, so a decision made in either place is the one decision. An action answered
 * here stays, folded to how it went, until the page is left. Given a Bot, only that Bot's.
 *
 * Given a `title`, it is its own section of a page, drawn only while something is listed.
 */
export function WaitingForYou({
  agentId,
  title,
}: {
  agentId?: string;
  title?: string;
}) {
  const inbox = useQuery(approvalInboxOptions());
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const [decidedHere, setDecidedHere] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const ours = (botId: string) => agentId === undefined || botId === agentId;
  const questions = (inbox.data?.questions ?? []).filter((question) =>
    ours(question.conversationBotId ?? question.botId),
  );
  const requests = (inbox.data?.requests ?? []).filter(
    (request) =>
      ours(request.action.botId) &&
      (request.status === "pending" || decidedHere.has(request.id)),
  );
  // A decision's failure is said on its own card.
  const error = inbox.error ?? answer.error;
  const listed = questions.length + requests.length > 0;
  if (title && !listed) return null;
  const list = (
    <>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {listed ? (
        <PageRows>
          {questions.map((question, index) => (
            <Fragment key={question.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconMessageQuestion />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="line-clamp-none">
                    {botName(question.botId)} asks: {question.question}
                  </ItemTitle>
                  {question.why ? (
                    <ItemDescription className="line-clamp-none">
                      {question.why}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                <ItemFooter className="flex-col items-start">
                  <Textarea
                    aria-label="Your answer"
                    onChange={(event) =>
                      setAnswers((prior) => ({
                        ...prior,
                        [question.id]: event.target.value,
                      }))
                    }
                    placeholder="Your answer"
                    value={answers[question.id] ?? ""}
                  />
                  <Button
                    disabled={answer.isPending || !answers[question.id]?.trim()}
                    onClick={() =>
                      answer.mutate({
                        id: question.id,
                        response: answers[question.id] ?? "",
                      })
                    }
                    size="sm"
                  >
                    Send answer
                  </Button>
                </ItemFooter>
              </Item>
            </Fragment>
          ))}
          {requests.map((request, index) => (
            <Fragment key={request.id}>
              {questions.length + index > 0 ? <Separator /> : null}
              <ApprovalCard
                botName={botName(request.action.botId)}
                busy={decision.isPending}
                error={
                  decision.variables?.id === request.id
                    ? (decision.error?.message ?? null)
                    : null
                }
                frame="row"
                onDecide={(choice) => {
                  // Kept here, folded, once answered: the person sees how it went.
                  setDecidedHere((prior) => new Set(prior).add(request.id));
                  decision.mutate({ id: request.id, choice });
                }}
                request={request}
              />
            </Fragment>
          ))}
        </PageRows>
      ) : null}
    </>
  );
  return title ? <PageSection title={title}>{list}</PageSection> : list;
}

/**
 * What one Bot is waiting on the person for, at the top of its page. Nothing is drawn when nothing
 * waits: the sidebar's badge already said whether to look.
 */
export function BotNeedsYou({ agentId }: { agentId: string }) {
  return <WaitingForYou agentId={agentId} title="Needs you" />;
}
