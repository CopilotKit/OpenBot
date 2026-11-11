import type {
  LearningProposal,
  LearningRunSummary,
} from "@openbot/shared/learning";
import { IconChevronRight, IconSparkles } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ProposalDialog } from "@/components/learning/proposal-dialog";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { skillTitle } from "@/lib/learning/display";
import {
  reviewPersonalProposalMutationOptions,
  saveAutoApproveMutationOptions,
  startPersonalLearningRunMutationOptions,
} from "@/lib/learning/mutations";
import {
  learningKeys,
  personalProposalQueryOptions,
  personalReviewQueryOptions,
} from "@/lib/learning/queries";
import { queryClient } from "@/query-client";

/** What a proposal would do to the Skills, in the person's words. */
function operationLabel(proposal: LearningProposal): string {
  switch (proposal.operation) {
    case "add":
      return "New skill";
    case "update":
      return `Update to ${skillTitle(proposal.title, proposal.description)}`;
    case "remove":
      return `Remove ${skillTitle(proposal.title, proposal.description)}`;
  }
}

const RUN_STATUS: Record<LearningRunSummary["status"], string> = {
  queued: "queued",
  freezing: "starting",
  batching: "analyzing",
  reducing: "analyzing",
  finalizing: "finishing",
  succeeded: "finished",
  failed: "failed",
};

type StartState = {
  pending: boolean;
  started: { from: string | null } | null;
  error: string | null;
};

/** Whether a run is going for one group: one it started and has not seen finish, or one the review shows running. */
function learningInProgress(
  group: { latestRun: LearningRunSummary | null },
  state: StartState | undefined,
): boolean {
  if (state?.pending) return true;
  const run = group.latestRun;
  const running =
    run !== null && run.status !== "succeeded" && run.status !== "failed";
  if (running) return true;
  // A newer run than the one there was at the click, and it is over: the run it started has finished.
  const finished = run !== null && run.id !== state?.started?.from;
  return state?.started != null && !finished;
}

/** Why Learn now couldn't start Learning for one group. */
function GroupError({ state }: { state: StartState | undefined }) {
  if (!state || state.pending || !state.error) return null;
  return (
    <p className="mt-4 text-destructive text-sm" role="alert">
      {state.error}
    </p>
  );
}

/**
 * Settings, Learning: the skills Learning proposed from the person's own recordings. Where people approve their own,
 * a row opens a dialog with Approve and Reject; where admins do, the same dialog is read-only.
 */
export function LearningReview() {
  const review = useQuery(personalReviewQueryOptions());
  const decide = useMutation(
    reviewPersonalProposalMutationOptions(queryClient),
  );
  const learnNow = useMutation(
    startPersonalLearningRunMutationOptions(queryClient),
  );
  const saveAutoApprove = useMutation(
    saveAutoApproveMutationOptions(queryClient),
  );
  const [open, setOpen] = useState<{ container: string; id: string } | null>(
    null,
  );
  // One Learn now covers a whole group: every source is tried, and the button waits for all of them.
  // Each group keeps its own state, keyed by label. `from` is the group's latest run when it started.
  const [starting, setStarting] = useState<
    Record<
      string,
      {
        pending: boolean;
        started: { from: string | null } | null;
        error: string | null;
      }
    >
  >({});
  // When a refetch finds fewer proposals waiting, some were approved on their own: Your skills shows them now.
  const waitingCount = review.data?.sources.reduce(
    (count, source) =>
      count +
      (source.proposals ?? []).filter(
        (proposal) => proposal.status === "pending_review",
      ).length,
    0,
  );
  const previousWaiting = useRef<number | undefined>(undefined);
  // Skills the sweep approved while the page opened are in Your skills too, including on the first load.
  const reviewData = review.data;
  useEffect(() => {
    if ((reviewData?.approved ?? 0) > 0)
      queryClient.invalidateQueries({ queryKey: learningKeys.personal });
  }, [reviewData]);
  useEffect(() => {
    if (waitingCount === undefined) return;
    if (
      previousWaiting.current !== undefined &&
      waitingCount < previousWaiting.current
    )
      queryClient.invalidateQueries({ queryKey: learningKeys.personal });
    previousWaiting.current = waitingCount;
  }, [waitingCount]);
  // A run Learn now started may not be listed at once; read the review again until it is, so the button comes back.
  const awaitingRun = Object.entries(starting).some(([label, state]) => {
    if (state.started === null) return false;
    const runs = (review.data?.sources ?? [])
      .filter((source) => source.label === label)
      .map((source) => source.latestRun)
      .filter((run) => run !== null);
    const latest = runs.reduce<LearningRunSummary | null>(
      (newest, run) =>
        !newest || run.createdAt > newest.createdAt ? run : newest,
      null,
    );
    return latest === null || latest.id === state.started.from;
  });
  const refetchReview = review.refetch;
  useEffect(() => {
    if (!awaitingRun) return;
    const timer = setInterval(() => void refetchReview(), 10_000);
    return () => clearInterval(timer);
  }, [awaitingRun, refetchReview]);
  if (review.isPending) return null;
  if (review.error) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        {review.error.message}
      </p>
    );
  }
  const { canReview, sources, autoApprove } = review.data;
  // Shown at once while the save is on its way, as a switch is.
  const autoApproveOn =
    (saveAutoApprove.isPending ? saveAutoApprove.variables : undefined) ??
    autoApprove;
  const unreadable = sources.some(
    (source) => source.proposals === null && !source.unavailable,
  );
  const unavailable = sources.some((source) => source.unavailable);
  // Sources that share a label are one group: the same words to the person, one Learn now.
  const groups: {
    label: string;
    containers: string[];
    latestRun: LearningRunSummary | null;
    waiting: { container: string; proposal: LearningProposal }[];
  }[] = [];
  for (const source of sources) {
    let group = groups.find((candidate) => candidate.label === source.label);
    if (!group) {
      group = {
        label: source.label,
        containers: [],
        latestRun: null,
        waiting: [],
      };
      groups.push(group);
    }
    group.containers.push(source.containerId);
    if (
      source.latestRun &&
      (!group.latestRun ||
        source.latestRun.createdAt > group.latestRun.createdAt)
    )
      group.latestRun = source.latestRun;
    for (const proposal of source.proposals ?? [])
      if (proposal.status === "pending_review")
        group.waiting.push({ container: source.containerId, proposal });
  }
  const anyWaiting = groups.some((group) => group.waiting.length > 0);
  // With automatic approval on, an empty list says nothing the switch doesn't.
  const showList = autoApproveOn !== true || anyWaiting;
  // The heading says something waits only when a skill does: not while Learning runs, and not with nothing left to approve.
  const heading = !anyWaiting
    ? { title: "New skills", description: undefined }
    : canReview
      ? {
          title: "Waiting for your review",
          description: "Approve a skill to publish it to your Bots.",
        }
      : {
          title: "Waiting for an admin",
          description:
            "An admin reviews these. You can read what Learning proposes here.",
        };
  const learnNowFor = async (group: {
    label: string;
    containers: string[];
  }) => {
    const from =
      groups.find((candidate) => candidate.label === group.label)?.latestRun
        ?.id ?? null;
    setStarting((all) => ({
      ...all,
      [group.label]: { pending: true, started: null, error: null },
    }));
    let started = false;
    let error: string | null = null;
    for (const container of group.containers) {
      try {
        await learnNow.mutateAsync(container);
        started = true;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
    setStarting((all) => ({
      ...all,
      [group.label]: {
        pending: false,
        started: started ? { from } : null,
        error,
      },
    }));
  };

  return (
    <PageSection title={heading.title} description={heading.description}>
      {autoApproveOn !== null && (
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Approve new skills automatically</ItemTitle>
              <ItemDescription>
                New skills go to your Bots without waiting for your review.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Approve new skills automatically"
                checked={autoApproveOn}
                disabled={saveAutoApprove.isPending}
                onCheckedChange={(checked) => saveAutoApprove.mutate(checked)}
              />
            </ItemActions>
          </Item>
        </PageRows>
      )}
      {groups
        .filter((group) => canReview || group.waiting.length > 0)
        .map((group) => (
          <Fragment key={group.label}>
            <PageRows>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{group.label}</ItemTitle>
                  {canReview && (
                    <ItemDescription>
                      {group.latestRun
                        ? [
                            `Latest run ${RUN_STATUS[group.latestRun.status]}.`,
                            group.latestRun.failure,
                          ]
                            .filter(Boolean)
                            .join(" ")
                        : "No run yet."}
                    </ItemDescription>
                  )}
                </ItemContent>
                {canReview && (
                  <ItemActions>
                    <Button
                      disabled={learningInProgress(
                        group,
                        starting[group.label],
                      )}
                      onClick={() => learnNowFor(group)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {learningInProgress(group, starting[group.label])
                        ? "Learning in progress…"
                        : "Learn now"}
                    </Button>
                  </ItemActions>
                )}
              </Item>
              {group.waiting.map(({ container, proposal }) => (
                <Fragment key={`${container}:${proposal.id}`}>
                  <Separator />
                  <Item
                    render={
                      <button
                        onClick={() => setOpen({ container, id: proposal.id })}
                        type="button"
                      />
                    }
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <IconSparkles />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {skillTitle(proposal.title, proposal.description)}
                      </ItemTitle>
                      <ItemDescription>{proposal.description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <span className="text-muted-foreground text-sm">
                        {operationLabel(proposal)}
                      </span>
                      <IconChevronRight className="size-4 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </Fragment>
              ))}
            </PageRows>
            {canReview && <GroupError state={starting[group.label]} />}
          </Fragment>
        ))}
      {showList && !anyWaiting && !unreadable && !unavailable && (
        <PageEmpty icon={IconSparkles} title="Nothing to review">
          {autoApprove !== null
            ? "New proposals show up here after Learning analyses your recordings and conversations."
            : "New proposals show up here after Learning analyses your recordings."}
        </PageEmpty>
      )}
      {saveAutoApprove.error && (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {saveAutoApprove.error.message}
        </p>
      )}
      {unavailable && (
        <p className="mt-4 text-muted-foreground text-sm">
          {sources.every((source) => source.unavailable)
            ? "Learning isn't available in the backend, so nothing is proposed here."
            : `Learning isn't available for ${[
                ...new Set(
                  sources
                    .filter((source) => source.unavailable)
                    .map((source) => source.label),
                ),
              ].join(", ")}, so nothing is proposed there.`}
        </p>
      )}
      {unreadable && (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {sources
            .filter((source) => !source.unavailable)
            .every((source) => source.proposals === null)
            ? "Couldn't read your proposed skills. Reload the page."
            : "Couldn't read some of your proposed skills. Reload the page."}
        </p>
      )}
      {open && (
        <ProposalDialog
          decided={decide.data?.status}
          deciding={decide.isPending}
          error={decide.error}
          load={personalProposalQueryOptions(open.container, open.id)}
          onClose={() => {
            setOpen(null);
            decide.reset();
          }}
          onDecide={
            canReview
              ? (decision) =>
                  decide.mutate({
                    container: open.container,
                    proposalId: open.id,
                    decision,
                  })
              : undefined
          }
          publishedNote="Published. Your Bots use it from their next conversation."
        />
      )}
    </PageSection>
  );
}
