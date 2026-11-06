import type { LearningProposal } from "@openbot/shared/learning";
import { IconChevronRight, IconSparkles } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ProposalDialog } from "@/components/learning/proposal-dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { reviewPersonalProposalMutationOptions } from "@/lib/learning/mutations";
import {
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

/**
 * Settings, Learning: the skills Learning proposed from the person's own recordings. Where people approve their own,
 * a row opens a dialog with Approve and Reject; where admins do, the same dialog is read-only.
 */
export function LearningReview() {
  const review = useQuery(personalReviewQueryOptions());
  const decide = useMutation(
    reviewPersonalProposalMutationOptions(queryClient),
  );
  const [open, setOpen] = useState<{ container: string; id: string } | null>(
    null,
  );
  if (review.isPending) return null;
  if (review.error) {
    return (
      <p className="mt-6 text-destructive text-sm" role="alert">
        {review.error.message}
      </p>
    );
  }
  const { canReview, sources } = review.data;
  const waiting = sources.flatMap((source) =>
    (source.proposals ?? [])
      .filter((proposal) => proposal.status === "pending_review")
      .map((proposal) => ({ container: source.containerId, proposal })),
  );
  const unreadable = sources.some((source) => source.proposals === null);

  return (
    <PageSection
      title={canReview ? "Waiting for your review" : "Waiting for an admin"}
      description={
        canReview
          ? "Approve a skill to publish it to your Bots."
          : "An admin reviews these. You can read what Learning proposes here."
      }
    >
      {waiting.length > 0 ? (
        <PageRows>
          {waiting.map(({ container, proposal }, index) => (
            <Fragment key={`${container}:${proposal.id}`}>
              {index > 0 ? <Separator /> : null}
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
      ) : unreadable ? null : (
        <PageEmpty icon={IconSparkles} title="Nothing to review">
          New proposals show up here after Learning analyses your recordings.
        </PageEmpty>
      )}
      {unreadable && (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {sources.every((source) => source.proposals === null)
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
