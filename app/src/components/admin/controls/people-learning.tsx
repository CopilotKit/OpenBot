import type { LearningPersonalReview } from "@openbot/shared/learning";
import { IconChevronRight, IconUserCheck } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
import { savePersonalReviewMutationOptions } from "@/lib/learning/mutations";
import { learningSettingsQueryOptions } from "@/lib/learning/queries";
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
      "Each person approves the skills learned from their own recordings.",
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
