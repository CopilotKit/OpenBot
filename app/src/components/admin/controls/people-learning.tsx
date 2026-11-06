import type { LearningPersonalReview } from "@openbot/shared/learning";
import {
  IconCheck,
  IconChevronRight,
  IconSparkles,
  IconUserCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ProposalDialog } from "@/components/learning/proposal-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  reviewPersonProposalMutationOptions,
  savePersonalReviewMutationOptions,
} from "@/lib/learning/mutations";
import {
  learningSettingsQueryOptions,
  peopleProposalsQueryOptions,
  personProposalQueryOptions,
} from "@/lib/learning/queries";
import { queryClient } from "@/query-client";

const CHOICES: {
  value: LearningPersonalReview;
  title: string;
  description: string;
}[] = [
  {
    value: "admins",
    title: "Admins",
    description:
      "A skill learned from a person's recordings waits for an admin.",
  },
  {
    value: "people",
    title: "Each person, for their own Bots",
    description:
      "Each person approves the skills learned from their own recordings. Those skills reach only that person's Bots until an admin shares them.",
  },
];

const LABEL = "Who approves skills learned from people's recordings";

/** Admin, Automatic learning: who approves the skills learned from a person's own recordings. */
export function WhoApprovesSection() {
  const [open, setOpen] = useState(false);
  const settings = useQuery(learningSettingsQueryOptions());
  if (settings.isPending || settings.error || !settings.data) return null;
  const current = settings.data.personalReview ?? "admins";
  return (
    <PageSection title="Approval">
      <PageRows>
        <Item
          render={<button onClick={() => setOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconUserCheck />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{LABEL}</ItemTitle>
            <ItemDescription>
              {CHOICES.find((choice) => choice.value === current)?.title}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
      {open ? (
        <WhoApprovesDialog current={current} onClose={() => setOpen(false)} />
      ) : null}
    </PageSection>
  );
}

function WhoApprovesDialog({
  current,
  onClose,
}: {
  current: LearningPersonalReview;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(current);
  const save = useMutation(savePersonalReviewMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{LABEL}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <PageRows>
            {CHOICES.map((choice, index) => (
              <Fragment key={choice.value}>
                {index > 0 ? <Separator /> : null}
                <Item
                  render={
                    <button
                      aria-pressed={draft === choice.value}
                      onClick={() => setDraft(choice.value)}
                      type="button"
                    />
                  }
                  size="sm"
                  variant="muted"
                >
                  <ItemContent>
                    <ItemTitle>{choice.title}</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {choice.description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {draft === choice.value ? (
                      <IconCheck
                        aria-hidden="true"
                        className="size-4 text-foreground"
                      />
                    ) : null}
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
          {save.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate(draft, { onSuccess: onClose })}
            size="sm"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin, Automatic learning: the skills proposed from each person's own recordings, while admins
 * are the ones who approve them. Hidden once each person approves their own.
 */
export function PeopleProposalsSection() {
  const settings = useQuery(learningSettingsQueryOptions());
  const admins = (settings.data?.personalReview ?? "admins") === "admins";
  const people = useQuery({
    ...peopleProposalsQueryOptions(),
    enabled: admins && !settings.isPending && !settings.error,
  });
  const review = useMutation(reviewPersonProposalMutationOptions(queryClient));
  const [open, setOpen] = useState<{
    userId: string;
    proposalId: string;
  } | null>(null);
  if (settings.isPending || settings.error || !admins) return null;
  const rows = (people.data?.people ?? []).flatMap((person) =>
    (person.proposals ?? [])
      .filter((proposal) => proposal.status === "pending_review")
      .map((proposal) => ({ person, proposal })),
  );
  const unreadable = (people.data?.people ?? []).filter(
    (person) => person.proposals === null,
  );
  return (
    <PageSection
      title="From people's recordings"
      description="Approve a skill to publish it to the Bots of the person who taught it."
    >
      {people.isPending ? null : people.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {people.error.message}
        </p>
      ) : (
        <>
          {unreadable.map((person) => (
            <p
              className="mt-4 text-destructive text-sm"
              key={person.userId}
              role="alert"
            >
              {`Couldn't read ${person.name}'s skills. Reload the page to try again.`}
            </p>
          ))}
          {rows.length === 0 ? (
            <PageEmpty icon={IconSparkles} title="Nothing to review">
              Skills learned from people's recordings appear here when they are
              ready.
            </PageEmpty>
          ) : (
            <PageRows>
              {rows.map(({ person, proposal }, index) => (
                <Fragment key={`${person.userId}:${proposal.id}`}>
                  {index > 0 ? <Separator /> : null}
                  <Item
                    render={
                      <button
                        onClick={() =>
                          setOpen({
                            userId: person.userId,
                            proposalId: proposal.id,
                          })
                        }
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
                      <ItemDescription>{person.name}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <IconChevronRight className="size-4 text-muted-foreground" />
                    </ItemActions>
                  </Item>
                </Fragment>
              ))}
            </PageRows>
          )}
        </>
      )}
      {open ? (
        <ProposalDialog
          decided={review.data?.status}
          deciding={review.isPending}
          error={review.error}
          load={personProposalQueryOptions(open.userId, open.proposalId)}
          onClose={() => {
            setOpen(null);
            review.reset();
          }}
          onDecide={(decision) => review.mutate({ ...open, decision })}
          publishedNote="Published. Their Bots use it from their next conversation."
        />
      ) : null}
    </PageSection>
  );
}
