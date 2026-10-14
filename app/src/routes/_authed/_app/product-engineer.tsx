import {
  IconBrandGithub,
  IconExternalLink,
  IconLoader2,
  IconRocket,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState, type FormEvent } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  approveProductEngineerPlanMutationOptions,
  approveProductEngineerRunMutationOptions,
  abandonProductEngineerRunMutationOptions,
  rejectProductEngineerPlanMutationOptions,
  resumeProductEngineerRunMutationOptions,
  startProductEngineerRunMutationOptions,
  syncProductEngineerRunMutationOptions,
} from "@/lib/product-engineer/mutations";
import {
  type ProductEngineerRun,
  productEngineerRunsQueryOptions,
} from "@/lib/product-engineer/queries";

export const Route = createFileRoute("/_authed/_app/product-engineer")({
  component: ProductEngineerPage,
});

const STATUS_LABEL: Record<ProductEngineerRun["status"], string> = {
  awaiting_plan_approval: "Awaiting plan approval",
  implementing: "Implementing",
  revising: "Revising",
  awaiting_review: "Awaiting review",
  approved: "Approved",
  failed: "Failed",
};

const STATUS_CLASS: Record<ProductEngineerRun["status"], string> = {
  awaiting_plan_approval: "bg-amber-50 text-amber-800",
  implementing: "bg-blue-50 text-blue-800",
  revising: "bg-blue-50 text-blue-800",
  awaiting_review: "bg-amber-50 text-amber-800",
  approved: "bg-emerald-50 text-emerald-800",
  failed: "bg-red-50 text-red-800",
};

function formatUpdatedAt(iso: string): string {
  const at = new Date(iso);
  const deltaMs = Date.now() - at.getTime();
  const minutes = Math.round(deltaMs / 60_000);
  // Avoid dateStyle/timeStyle + timeZoneName together — some runtimes throw
  // "Invalid option : option" (RangeError) when those are mixed.
  const absolute = at.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  if (minutes < 1) return `Updated just now (${absolute})`;
  if (minutes < 60) return `Updated ${minutes}m ago (${absolute})`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Updated ${hours}h ago (${absolute})`;
  return `Updated ${absolute}`;
}

function ProductEngineerPage() {
  const queryClient = useQueryClient();
  const runsQuery = useQuery(productEngineerRunsQueryOptions());
  const startMutation = useMutation(
    startProductEngineerRunMutationOptions(queryClient),
  );
  const resumeMutation = useMutation(
    resumeProductEngineerRunMutationOptions(queryClient),
  );
  const approveMutation = useMutation(
    approveProductEngineerRunMutationOptions(queryClient),
  );
  const approvePlanMutation = useMutation(
    approveProductEngineerPlanMutationOptions(queryClient),
  );
  const rejectPlanMutation = useMutation(
    rejectProductEngineerPlanMutationOptions(queryClient),
  );
  const syncMutation = useMutation(
    syncProductEngineerRunMutationOptions(queryClient),
  );
  const abandonMutation = useMutation(
    abandonProductEngineerRunMutationOptions(queryClient),
  );

  const startTicketFieldId = useId();
  const [ticketId, setTicketId] = useState("");
  const [feedbackByTicket, setFeedbackByTicket] = useState<
    Record<string, string>
  >({});
  const [formError, setFormError] = useState<string | null>(null);

  const runs = runsQuery.data?.runs ?? [];

  async function onStart(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    try {
      await startMutation.mutateAsync(ticketId.trim());
      setTicketId("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <PageShell
      title="Product Engineer"
      description="Draft a plan from a Linear ticket, approve it, then dispatch Cursor cloud coding. Merge stays in GitHub."
    >
      <section className="space-y-4 border-b border-border pb-8">
        <h2 className="text-sm font-semibold tracking-wide text-foreground/80 uppercase">
          Start run
        </h2>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={onStart}
        >
          <label
            className="flex min-w-0 flex-1 flex-col gap-1.5"
            htmlFor={startTicketFieldId}
          >
            <span className="text-sm text-muted-foreground">
              Linear ticket id
            </span>
            <Input
              id={startTicketFieldId}
              autoComplete="off"
              placeholder="ORC-424"
              value={ticketId}
              onChange={(event) => setTicketId(event.target.value)}
            />
          </label>
          <Button
            disabled={startMutation.isPending || !ticketId.trim()}
            type="submit"
          >
            {startMutation.isPending ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconRocket className="size-4" />
            )}
            Draft plan
          </Button>
        </form>
        {formError ? (
          <p className="whitespace-pre-wrap text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Start drafts a plan for your approval. Cursor coding begins only after
          you approve. Private repos need the Cursor GitHub App under Dashboard
          → Integrations.
        </p>
      </section>

      <section className="space-y-4 pt-8">
        <h2 className="text-sm font-semibold tracking-wide text-foreground/80 uppercase">
          Active / recent runs
        </h2>
        {runsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading runs…</p>
        ) : null}
        {runsQuery.isError ? (
          <p className="whitespace-pre-wrap text-sm text-destructive">
            {runsQuery.error instanceof Error
              ? runsQuery.error.message
              : "Could not load runs. Is Product Engineer configured on the server?"}
          </p>
        ) : null}
        {!runsQuery.isLoading && !runsQuery.isError && runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs yet. Start one with a Linear ticket id.
          </p>
        ) : null}

        <ul className="space-y-6">
          {runs.map((run) => {
            const busy =
              run.status === "implementing" || run.status === "revising";
            const feedback = feedbackByTicket[run.ticketId] ?? "";
            return (
              <li
                key={run.ticketId}
                className="space-y-3 border-b border-border pb-6 last:border-0"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{run.ticketId}</span>
                      <span
                        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[run.status]}`}
                      >
                        {busy ? (
                          <IconLoader2 className="size-3 animate-spin" />
                        ) : null}
                        {STATUS_LABEL[run.status]}
                      </span>
                    </div>
                    <p className="text-sm text-foreground/90">{run.title}</p>
                    {run.agentId ? (
                      <p className="font-mono text-xs text-muted-foreground">
                        agent {run.agentId}
                      </p>
                    ) : busy ? (
                      <p className="text-xs text-muted-foreground">
                        Waiting for Cursor agent id…
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {formatUpdatedAt(run.updatedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {busy && run.agentId ? (
                      <Button
                        disabled={syncMutation.isPending}
                        onClick={async () => {
                          try {
                            await syncMutation.mutateAsync(run.ticketId);
                          } catch (error) {
                            setFormError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                        size="sm"
                        variant="secondary"
                      >
                        {syncMutation.isPending ? (
                          <IconLoader2 className="size-3.5 animate-spin" />
                        ) : null}
                        Refresh from Cursor
                      </Button>
                    ) : null}
                    {busy ? (
                      <Button
                        disabled={abandonMutation.isPending}
                        onClick={async () => {
                          try {
                            await abandonMutation.mutateAsync(run.ticketId);
                          } catch (error) {
                            setFormError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Mark failed
                      </Button>
                    ) : null}
                    <Button
                      render={(props) => (
                        <a
                          {...props}
                          href={run.linearUrl}
                          target="_blank"
                          rel="noreferrer"
                        />
                      )}
                      size="sm"
                      variant="outline"
                    >
                      <IconExternalLink className="size-3.5" />
                      Linear
                    </Button>
                    {run.agentId ? (
                      <Button
                        render={(props) => (
                          <a
                            {...props}
                            href="https://cursor.com/agents"
                            target="_blank"
                            rel="noreferrer"
                          />
                        )}
                        size="sm"
                        variant="outline"
                      >
                        <IconExternalLink className="size-3.5" />
                        Cursor Agents
                      </Button>
                    ) : null}
                    {run.prUrl ? (
                      <Button
                        render={(props) => (
                          <a
                            {...props}
                            href={run.prUrl}
                            target="_blank"
                            rel="noreferrer"
                          />
                        )}
                        size="sm"
                        variant="outline"
                      >
                        <IconBrandGithub className="size-3.5" />
                        Pull request
                      </Button>
                    ) : null}
                  </div>
                </div>

                {run.progress ? (
                  <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 font-mono text-xs text-foreground/90">
                    {run.progress}
                  </pre>
                ) : null}

                {run.error ? (
                  <p className="whitespace-pre-wrap rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
                    {run.error}
                  </p>
                ) : null}

                {run.status === "awaiting_plan_approval" ? (
                  <div className="space-y-3">
                    {run.plan ? (
                      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2 font-mono text-xs text-foreground/90">
                        {run.plan}
                      </pre>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No plan text on this run.
                      </p>
                    )}
                    <label
                      className="flex flex-col gap-1.5"
                      htmlFor={`pe-plan-feedback-${run.ticketId}`}
                    >
                      <span className="text-sm text-muted-foreground">
                        Feedback to revise the plan (optional for approve)
                      </span>
                      <Textarea
                        id={`pe-plan-feedback-${run.ticketId}`}
                        placeholder="What should change in the plan before coding?"
                        rows={3}
                        value={feedback}
                        onChange={(event) =>
                          setFeedbackByTicket((prev) => ({
                            ...prev,
                            [run.ticketId]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={approvePlanMutation.isPending}
                        onClick={async () => {
                          try {
                            await approvePlanMutation.mutateAsync(run.ticketId);
                          } catch (error) {
                            setFormError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                      >
                        {approvePlanMutation.isPending ? (
                          <IconLoader2 className="size-4 animate-spin" />
                        ) : null}
                        Approve plan & start coding
                      </Button>
                      <Button
                        disabled={
                          rejectPlanMutation.isPending || !feedback.trim()
                        }
                        onClick={async () => {
                          try {
                            await rejectPlanMutation.mutateAsync({
                              ticketId: run.ticketId,
                              feedback: feedback.trim(),
                            });
                            setFeedbackByTicket((prev) => ({
                              ...prev,
                              [run.ticketId]: "",
                            }));
                          } catch (error) {
                            setFormError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                        variant="secondary"
                      >
                        {rejectPlanMutation.isPending ? (
                          <IconLoader2 className="size-4 animate-spin" />
                        ) : null}
                        Revise plan
                      </Button>
                      <Button
                        disabled={abandonMutation.isPending}
                        onClick={async () => {
                          try {
                            await abandonMutation.mutateAsync(run.ticketId);
                          } catch (error) {
                            setFormError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Cancel
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Coding does not start until you approve this plan.
                    </p>
                  </div>
                ) : null}

                {run.status === "awaiting_review" ? (
                  <div className="space-y-3">
                    <label
                      className="flex flex-col gap-1.5"
                      htmlFor={`pe-resume-feedback-${run.ticketId}`}
                    >
                      <span className="text-sm text-muted-foreground">
                        Feedback to resume
                      </span>
                      <Textarea
                        id={`pe-resume-feedback-${run.ticketId}`}
                        placeholder="What should the Product Engineer change?"
                        rows={4}
                        value={feedback}
                        onChange={(event) =>
                          setFeedbackByTicket((prev) => ({
                            ...prev,
                            [run.ticketId]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={resumeMutation.isPending || !feedback.trim()}
                        onClick={async () => {
                          try {
                            await resumeMutation.mutateAsync({
                              ticketId: run.ticketId,
                              feedback: feedback.trim(),
                            });
                            setFeedbackByTicket((prev) => ({
                              ...prev,
                              [run.ticketId]: "",
                            }));
                          } catch (error) {
                            setFormError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                        variant="secondary"
                      >
                        {resumeMutation.isPending ? (
                          <IconLoader2 className="size-4 animate-spin" />
                        ) : null}
                        Resume with feedback
                      </Button>
                      <Button
                        disabled={approveMutation.isPending}
                        onClick={async () => {
                          try {
                            await approveMutation.mutateAsync(run.ticketId);
                          } catch (error) {
                            setFormError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                      >
                        {approveMutation.isPending ? (
                          <IconLoader2 className="size-4 animate-spin" />
                        ) : null}
                        Approve (certify only)
                      </Button>
                      <Button
                        disabled={abandonMutation.isPending}
                        onClick={async () => {
                          try {
                            await abandonMutation.mutateAsync(run.ticketId);
                          } catch (error) {
                            setFormError(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Cancel
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Approve marks this run certified in AgentForce. Merging
                      the PR stays in GitHub.
                    </p>
                  </div>
                ) : null}

                {busy ? (
                  <p className="text-xs text-muted-foreground">
                    {run.progress
                      ? "Live progress above updates every few seconds while the cloud agent streams."
                      : "Polling… full transcript is also in Cursor Agents (filter Source → SDK) and server.log."}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </PageShell>
  );
}
