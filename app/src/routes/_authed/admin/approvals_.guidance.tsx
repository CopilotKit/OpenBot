import { IconShieldLock } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { GuidanceBacktestField } from "@/components/approvals/guidance-backtest";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import {
  PageCard,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  backtestReviewerGuidance,
  checkReviewerGuidance,
  GUIDANCE_LIMIT,
  type GuidanceReading,
} from "@/lib/reviewer-guidance/check";
import {
  removeReviewerGuidanceMutationOptions,
  saveReviewerGuidanceMutationOptions,
} from "@/lib/reviewer-guidance/mutations";
import {
  guidanceBacktestPreviewQueryOptions,
  reviewerGuidanceQueryOptions,
} from "@/lib/reviewer-guidance/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/approvals_/guidance")({
  component: ReviewerGuidancePage,
});

const BACK = {
  label: "Approvals",
  linkProps: { to: "/admin/approvals" as const },
};

/**
 * Guidance for auto-review, in the admin's words, with the describe screen's pattern: write it, check
 * it, test it on recent decisions, then save it.
 *
 * Check hands the words to a call that sees nothing else, which says what they change and whether they
 * read as guidance at all. The replay costs one model call a request, so it runs only when the admin
 * presses for it, after being told how many. Save reads the words again on the server, and only
 * guidance that still reads as guidance is saved, on the trail, with the words.
 */
function ReviewerGuidancePage() {
  const navigate = Route.useNavigate();
  const saved = useQuery(reviewerGuidanceQueryOptions());
  const preview = useQuery(guidanceBacktestPreviewQueryOptions());
  const save = useMutation(saveReviewerGuidanceMutationOptions(queryClient));
  const remove = useMutation(
    removeReviewerGuidanceMutationOptions(queryClient),
  );
  const check = useMutation({ mutationFn: checkReviewerGuidance });
  const backtest = useMutation({ mutationFn: backtestReviewerGuidance });
  /* Null until the admin types, so the saved guidance shows once it has loaded. */
  const [draft, setDraft] = useState<string | null>(null);
  const [checked, setChecked] = useState<{
    text: string;
    reading: GuidanceReading;
  } | null>(null);

  const text = (draft ?? saved.data ?? "").trim();
  const passed =
    checked !== null && checked.text === text && checked.reading.check.ok;
  const unchanged = text === (saved.data ?? "");
  const ready = passed && !unchanged;
  const [removing, setRemoving] = useState(false);
  const back = () => void navigate({ to: "/admin/approvals" });

  const runCheck = () => {
    if (!text || check.isPending) return;
    save.reset();
    check.mutate(text, {
      onSuccess: (reading) => setChecked({ text, reading }),
    });
  };

  return (
    <PageShell
      backButton={BACK}
      description="Tell the reviewer what your organization needs a person for, or what is routine. It reads your guidance with every action it checks. Nothing changes until you save."
      title="Guidance for auto-review"
    >
      {saved.isPending ? null : saved.error ? (
        <p className="text-destructive text-sm" role="alert">
          {saved.error.message}
        </p>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save.mutate(text, { onSuccess: back });
          }}
        >
          <PageCard
            footer={
              <>
                <Button
                  render={(props) => <Link {...props} to="/admin/approvals" />}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button disabled={!ready || save.isPending} type="submit">
                  {save.isPending ? "Saving…" : "Save guidance"}
                </Button>
              </>
            }
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reviewer-guidance">Guidance</FieldLabel>
                <FieldDescription>
                  Write it the way you'd brief a colleague. A second reading
                  that sees only your words says what they change.
                </FieldDescription>
                <Textarea
                  id="reviewer-guidance"
                  maxLength={GUIDANCE_LIMIT}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Anything that emails someone outside the company needs a person"
                  rows={4}
                  value={draft ?? saved.data ?? ""}
                />
                <p className="flex gap-1.5 text-muted-foreground text-sm">
                  <IconShieldLock className="mt-0.5 size-4 shrink-0" />
                  <span>
                    Built-in safety always comes first. Deleting, sending,
                    sharing, posting, paying and changing account settings ask
                    first. Members can allow each once, for a conversation, or
                    always, unless you set it to ask every time. Changing a
                    password on a website is always left to the person. Guidance
                    can't change that.
                  </span>
                </p>
                <div>
                  <Button
                    disabled={!text || check.isPending}
                    onClick={runCheck}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {check.isPending ? "Checking…" : "Check guidance"}
                  </Button>
                </div>
                {check.error ? (
                  <p className="text-destructive text-sm" role="alert">
                    {check.error.message}
                  </p>
                ) : null}
              </Field>
              {checked ? (
                <ReadingStatus
                  check={checked.reading.check}
                  edited={
                    checked.text !== text
                      ? "You've changed the guidance since it was checked. Check it again before you save."
                      : null
                  }
                  explanation={checked.reading.explanation}
                  failed="OpenBot won't save this."
                  heading="What this changes"
                  passed="Reads as guidance. Built-in safety still comes first."
                  warning={null}
                />
              ) : null}
              {passed ? (
                <GuidanceBacktestField
                  preview={preview.data}
                  run={backtest}
                  text={text}
                />
              ) : null}
            </FieldGroup>
            {save.error ? (
              <p className="mt-5 text-destructive text-sm" role="alert">
                {save.error.message}
              </p>
            ) : null}
          </PageCard>
        </form>
      )}
      {saved.data ? (
        <PageSection
          description="The reviewer goes back to its own instructions from the next action it checks."
          title="Remove"
        >
          <Button
            className="mt-4"
            onClick={() => {
              remove.reset();
              setRemoving(true);
            }}
            variant="destructive"
          >
            Remove guidance
          </Button>
        </PageSection>
      ) : null}
      <Dialog onOpenChange={setRemoving} open={removing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove the guidance?</DialogTitle>
            <DialogDescription>
              The reviewer goes back to its own instructions from the next
              action it checks.
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p className="text-destructive text-sm" role="alert">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setRemoving(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: back })}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
