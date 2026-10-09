import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalDecision,
  answerPersonQuestion,
  approvalInboxOptions,
  decideApproval,
} from "@/lib/approvals";

/**
 * Questions and actions waiting on the person, each decided where it is shown. Given a Bot, only
 * that Bot's. The same requests the conversation draws inline, so a decision made in either place is
 * the one decision.
 */
export function WaitingForYou({ agentId }: { agentId?: string }) {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
  const refresh = () => cache.invalidateQueries({ queryKey: ["approvals"] });
  const decision = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalDecision }) =>
      decideApproval(id, choice),
    onSuccess: refresh,
  });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = useMutation({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      answerPersonQuestion(id, response),
    onSuccess: refresh,
  });
  const ours = (botId: string) => agentId === undefined || botId === agentId;
  const questions = (inbox.data?.questions ?? []).filter((question) =>
    ours(question.botId),
  );
  const pending = (inbox.data?.requests ?? []).filter(
    (request) => request.status === "pending" && ours(request.action.botId),
  );
  const error = inbox.error ?? decision.error ?? answer.error;
  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      <div className="space-y-3">
        <h2 className="font-medium">Waiting for you</h2>
        {questions.map((question) => (
          <article
            key={question.id}
            className="space-y-3 rounded-lg border p-4"
          >
            <h3 className="font-medium">
              {botName(question.botId)} asks: {question.question}
            </h3>
            {question.why ? (
              <p className="text-sm text-muted-foreground">{question.why}</p>
            ) : null}
            <Textarea
              aria-label="Your answer"
              placeholder="Your answer"
              value={answers[question.id] ?? ""}
              onChange={(event) =>
                setAnswers((prior) => ({
                  ...prior,
                  [question.id]: event.target.value,
                }))
              }
            />
            <Button
              disabled={answer.isPending || !answers[question.id]?.trim()}
              onClick={() =>
                answer.mutate({
                  id: question.id,
                  response: answers[question.id] ?? "",
                })
              }
            >
              Send answer
            </Button>
          </article>
        ))}
        {inbox.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading approvals…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No actions need your approval.
          </p>
        ) : (
          pending.map((request) => (
            <article
              className="space-y-3 rounded-lg border p-4"
              key={request.id}
            >
              <div>
                <h3 className="font-medium">
                  {botName(request.action.botId)} wants to{" "}
                  {request.action.toolRef
                    .replace(/^computer_|^host\//, "")
                    .replaceAll("_", " ")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {request.action.scope}
                </p>
                {request.action.policy ? (
                  <p className="text-sm">
                    {request.action.policy.behaviour === "hand_off"
                      ? "Handed to you: "
                      : ""}
                    {request.action.policy.reason}
                  </p>
                ) : null}
              </div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                {JSON.stringify(request.action.args, null, 2)}
              </pre>
              {request.action.policy?.behaviour === "hand_off" ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "handled" })
                    }
                  >
                    I did it myself
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "deny" })
                    }
                  >
                    Don't do it
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "allow_once" })
                    }
                  >
                    Allow once
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({
                        id: request.id,
                        choice: "allow_always",
                      })
                    }
                  >
                    Always allow here
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "deny" })
                    }
                  >
                    Deny
                  </Button>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </>
  );
}

/**
 * What one Bot is waiting on the person for, at the top of its page. Nothing is drawn when nothing
 * waits: the sidebar's badge already said whether to look.
 */
export function BotNeedsYou({ agentId }: { agentId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const waiting =
    (inbox.data?.questions ?? []).some(
      (question) => question.botId === agentId,
    ) ||
    (inbox.data?.requests ?? []).some(
      (request) =>
        request.status === "pending" && request.action.botId === agentId,
    );
  if (!waiting) return null;
  return (
    <PageSection title="Needs you">
      <div className="mt-4">
        <WaitingForYou agentId={agentId} />
      </div>
    </PageSection>
  );
}
