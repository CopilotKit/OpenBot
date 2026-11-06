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
      return `Update to ${proposal.title}`;
    case "remove":
      return `Remove ${proposal.title}`;
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
  const [starting, setStarting] = useState<{
    pending: boolean;
    started: boolean;
    error: string | null;
  }>({ pending: false, started: false, error: null });
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
  useEffect(() => {
    if (waitingCount === undefined) return;
    if (
      previousWaiting.current !== undefined &&
      waitingCount < previousWaiting.current
    )
      queryClient.invalidateQueries({ queryKey: learningKeys.personal });
    previousWaiting.current = waitingCount;
  }, [waitingCount]);
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
  const learnNowFor = async (containers: string[]) => {
    setStarting({ pending: true, started: false, error: null });
    let started = false;
    let error: string | null = null;
    for (const container of containers) {
      try {
        await learnNow.mutateAsync(container);
        started = true;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
    setStarting({ pending: false, started, error });
  };

  return (
    <PageSection
      title={canReview ? "Waiting for your review" : "Waiting for an admin"}
      description={
        canReview
          ? "Approve a skill to publish it to your Bots."
          : "An admin reviews these. You can read what Learning proposes here."
      }
    >
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
          <PageRows key={group.label}>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>{group.label}</ItemTitle>
                {canReview && (
                  <ItemDescription>
                    {group.latestRun
                      ? `Latest run ${RUN_STATUS[group.latestRun.status]}.`
                      : "No run yet."}
                  </ItemDescription>
                )}
              </ItemContent>
              {canReview && (
                <ItemActions>
                  <Button
                    disabled={starting.pending}
                    onClick={() => learnNowFor(group.containers)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {starting.pending ? "Starting…" : "Learn now"}
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
                    <ItemTitle>{proposal.title}</ItemTitle>
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
        ))}
      {showList &&
        !anyWaiting &&
        !unreadable &&
        !(unavailable && sources.every((source) => source.unavailable)) && (
          <PageEmpty icon={IconSparkles} title="Nothing to review">
            {autoApprove !== null
              ? "New proposals show up here after Learning analyses your recordings and conversations."
              : "New proposals show up here after Learning analyses your recordings."}
          </PageEmpty>
        )}
      {canReview && !starting.pending && starting.started && (
        <p className="mt-4 text-sm" role="status">
          Learning started. New proposals show up here when it finishes.
        </p>
      )}
      {saveAutoApprove.error && (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {saveAutoApprove.error.message}
        </p>
      )}
      {canReview && !starting.pending && starting.error && (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {starting.error}
        </p>
      )}
      {unavailable && (
        <p className="mt-4 text-muted-foreground text-sm">
          Learning isn't available in Intelligence, so nothing is proposed here.
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
