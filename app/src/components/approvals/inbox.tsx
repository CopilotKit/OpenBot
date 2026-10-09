import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type ApprovalDecision,
  answerPersonQuestion,
  approvalInboxOptions,
  createApprovalRuleMutationOptions,
  decideApproval,
  revokeApprovalRuleMutationOptions,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient as appQueryClient } from "@/query-client";
import { RuleForm, RuleRow } from "./rules";

/**
 * What is waiting for the person, and rules that name a single Bot.
 *
 * Whether to ask at all, and rules for every Bot, are in Settings → Approvals; team settings are in
 * Admin → Approvals.
 */
export function ApprovalInbox() {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
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
  const addRule = useMutation(
    createApprovalRuleMutationOptions(appQueryClient),
  );
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(appQueryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(appQueryClient));
  const error =
    inbox.error ??
    decision.error ??
    answer.error ??
    addRule.error ??
    changeRule.error ??
    revoke.error;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  const oneBot = (inbox.data?.rules ?? []).filter((rule) => rule.botId !== "*");
  const pending =
    inbox.data?.requests.filter((request) => request.status === "pending") ??
    [];
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Whether your Bots ask before acting, and rules for every Bot, are in{" "}
        <Link className="underline underline-offset-4" to="/settings/approvals">
          Settings → Approvals
        </Link>
        .
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      <div className="space-y-3">
        <h2 className="font-medium">Waiting for you</h2>
        {inbox.data?.questions.map((question) => (
          <article
            key={question.id}
            className="space-y-3 rounded-lg border p-4"
          >
            <h3 className="font-medium">
              {question.botId} asks: {question.question}
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
                  {request.action.botId} wants to{" "}
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
      <div className="space-y-3">
        <h2 className="font-medium">Rules for one Bot</h2>
        {rulesOff ? (
          <p className="text-sm text-muted-foreground">
            Your team has switched personal rules off, so they are kept but do
            not apply.
          </p>
        ) : null}
        {oneBot.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            locked={rulesOff}
            disabled={revoke.isPending || changeRule.isPending}
            onRevoke={() => revoke.mutate(rule.id)}
            onChange={(behaviour) =>
              changeRule.mutate({ id: rule.id, behaviour })
            }
          />
        ))}
        {oneBot.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rules for a single Bot.
          </p>
        ) : null}
        {inbox.data?.preferences && !rulesOff ? (
          <RuleForm
            label="Add a rule for one Bot"
            pending={addRule.isPending}
            onSave={(input) => addRule.mutate(input)}
          />
        ) : null}
      </div>
    </div>
  );
}
