import {
  IconChevronRight,
  IconCircleCheck,
  IconFlag,
  IconHistory,
  IconMessage,
  IconPlayerPause,
  IconPlayerPlay,
  IconProgress,
  IconTarget,
  IconWebhook,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, type LinkProps, useNavigate } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import { Streamdown } from "streamdown";
import { LoadingRows } from "@/components/layout/loading-rows";
import {
  PageCard,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { DeleteRow } from "@/components/routines/delete-row";
import { GoalSchedules } from "@/components/routines/goal-schedules";
import { routinesOf } from "@/components/routines/new-routine-page";
import {
  RoutineDetailMissing,
  useDeletedHere,
} from "@/components/routines/routine-detail-missing";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { markdownComponents } from "@/lib/markdown";
import {
  deleteResponsibilityMutationKey,
  deleteResponsibilityMutationOptions,
  type ResponsibilityRecord,
  responsibilitiesQueryOptions,
  responsibilityActionMutationOptions,
  responsibilityRunsQueryOptions,
  type TriggerRecord,
  triggersQueryOptions,
  updateResponsibilityMutationOptions,
} from "@/lib/responsibilities";
import { describeEvent, eventIdentifier } from "@/lib/routines/events";
import { goalStarts } from "@/lib/routines/merged";
import {
  type RoutineRecord,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { KIND_LABEL, Triggers } from "./triggers";

type Status = ResponsibilityRecord["status"];

/** A responsibility's state, as a word and as the mark its row leads with. */
export const STATUS: Record<
  Status,
  { label: string; icon: typeof IconTarget }
> = {
  active: { label: "Active", icon: IconTarget },
  paused: { label: "Paused", icon: IconPlayerPause },
  completed: { label: "Completed", icon: IconCircleCheck },
};

/**
 * What a responsibility's page says under its title: its state, and while it is active, what starts
 * it. Computed from the queries on every render so it follows whatever the page just changed.
 *
 * The starts are the Routines list's own (`goalStarts`): the schedule of each enabled routine, then
 * its events, then its enabled triggers. A schedule that is switched off starts nothing, so a goal
 * with only that reads "Schedule off", as it does on the list.
 *
 * `triggers` is undefined until they load, and then nothing is said about what starts it rather than
 * "Runs when asked", which would be a claim about triggers nobody has read yet. An enabled schedule
 * is already known, so it is named at once. `routines` is undefined when they could not be read, and
 * then it is not "Runs when asked" either: schedules may run it that nobody could list.
 */
export function summaryFor(
  goal: ResponsibilityRecord,
  triggers: TriggerRecord[] | undefined,
  routines: readonly RoutineRecord[] | undefined,
): string {
  const status = STATUS[goal.status].label;
  if (goal.status === "completed") return status;
  if (goal.status === "paused")
    return `${status} · Nothing starts it until you resume it`;
  const starts = goalStarts(
    goal,
    triggers
      ?.filter((trigger) => trigger.enabled)
      .map((trigger) => `${KIND_LABEL[trigger.kind]} trigger`),
    routines,
    describeEvent,
  );
  if (starts === null) return status;
  return `${status} · ${starts === "When you ask" ? "Runs when asked" : starts}`;
}

/**
 * A goal's page at `/routines/goals/$goalId`, reached from its row on a Routines list.
 *
 * It was a dialog over the list, and a goal holds too much for one: four actions, three fields, where
 * it stands, its schedules, events and triggers, and its runs. In a dialog's scrolling body the
 * rounded sections shrank and clipped on any screen shorter than all of that, so it is a page, with
 * the page's own sections and its own scroller.
 *
 * Read from the goals list rather than a read of its own, so the row and the page are the same
 * record and every refetch reaches both. `agentId` is the Bot whose Routines page it came from, for
 * the back link; absent, it goes back to every Bot's.
 */
export function GoalRoutePage({
  goalId,
  agentId,
}: {
  goalId: string;
  agentId?: string;
}) {
  const goals = useQuery(responsibilitiesQueryOptions());
  const routines = useQuery(routinesQueryOptions());
  const deleted = useDeletedHere<string>(
    deleteResponsibilityMutationKey,
    (id) => id === goalId,
  );
  const back = routinesOf(agentId);
  const goal = goals.data?.find((row) => row.id === goalId);

  if (goal)
    return (
      <GoalPage
        back={back}
        goal={goal}
        key={goal.id}
        routines={
          routines.error
            ? undefined
            : (routines.data?.routines ?? []).filter(
                (routine) => routine.goalId === goal.id,
              )
        }
      />
    );

  return (
    <RoutineDetailMissing
      back={back}
      deleted={deleted}
      icon={IconTarget}
      kind="goal"
      read={goals}
    />
  );
}

/**
 * What deleting a goal takes with it. The server deletes the routines that run it too; when they
 * couldn't be read, the sentence says so without claiming there are none.
 */
function deleteWords(routines: readonly RoutineRecord[] | undefined): string {
  if (routines === undefined)
    return "It stops for good, with its runs and any schedules that run it.";
  return routines.length > 0
    ? "It stops for good, with its schedules and its runs."
    : "It stops for good, with its runs.";
}

/**
 * Everything about one goal: what can be done to it now (pause, run, complete — each immediate),
 * its wording (a draft, saved by its own button), where it stands, what starts it (its schedules,
 * events and triggers), and its runs.
 */
export function GoalPage({
  goal,
  routines,
  back,
}: {
  goal: ResponsibilityRecord;
  /**
   * The routines that run it: on the Routines list they are its starts, changed here. Undefined when
   * the routines could not be read, so what starts it and what a delete takes with it are not known.
   */
  routines: readonly RoutineRecord[] | undefined;
  /** The Routines list it came from. */
  back: LinkProps;
}) {
  const formId = useId();
  const [title, setTitle] = useState(goal.title);
  const [instruction, setInstruction] = useState(goal.instruction);
  const [successCriteria, setSuccessCriteria] = useState(goal.successCriteria);
  const [criteriaMissing, setCriteriaMissing] = useState(false);
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const action = useMutation(responsibilityActionMutationOptions(queryClient));
  const edit = useMutation(updateResponsibilityMutationOptions(queryClient));
  const remove = useMutation(deleteResponsibilityMutationOptions(queryClient));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const navigate = useNavigate();
  const changed =
    title !== goal.title ||
    instruction !== goal.instruction ||
    successCriteria !== goal.successCriteria;
  // Not known: the sentence that leaves no schedule out.
  const starters =
    routines === undefined || routines.some((routine) => routine.enabled)
      ? "schedules, events and triggers"
      : "events and triggers";
  const standing = [
    goal.progress
      ? {
          key: "progress",
          label: "Progress",
          icon: IconProgress,
          text: goal.progress,
        }
      : null,
    goal.lastResult
      ? {
          key: "result",
          label: "Last result",
          icon: IconFlag,
          text: goal.lastResult,
        }
      : null,
  ].filter((entry) => entry !== null);

  return (
    <PageShell
      backButton={{ label: "Routines", linkProps: back }}
      description={summaryFor(goal, triggers.data, routines)}
      title={goal.title}
    >
      {/* What can be done to it now. The page title names it, so this first section has no heading. */}
      <PageSection>
        <PageRows>
          {goal.status !== "completed" ? (
            <>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconTarget />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Active</ItemTitle>
                  <ItemDescription>
                    {goal.status === "active"
                      ? `Its ${starters} start it.`
                      : `Paused. Its ${starters} won't start it.`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Active"
                    checked={goal.status === "active"}
                    disabled={action.isPending}
                    onCheckedChange={(active) =>
                      action.mutate({
                        id: goal.id,
                        action: active ? "resume" : "pause",
                      })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
            </>
          ) : null}
          {goal.status === "active" ? (
            <>
              <Item
                render={
                  <button
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({ id: goal.id, action: "run" })
                    }
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconPlayerPlay />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Run now</ItemTitle>
                  <ItemDescription>
                    Runs it now, for real. The Bot does the work and can post
                    and take actions.
                  </ItemDescription>
                </ItemContent>
              </Item>
              <Separator />
            </>
          ) : null}
          {goal.status !== "completed" ? (
            <>
              <Item
                render={
                  <button
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({ id: goal.id, action: "complete" })
                    }
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconCircleCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Complete</ItemTitle>
                  <ItemDescription>
                    Mark it done. Nothing starts it after this.
                  </ItemDescription>
                </ItemContent>
              </Item>
              <Separator />
            </>
          ) : null}
          <Item
            render={
              <Link
                params={{ channelId: goal.channelId }}
                to="/channel/$channelId"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconMessage />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Open conversation</ItemTitle>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          <Separator />
          <DeleteRow
            description={deleteWords(routines)}
            label={`Delete the goal ${goal.title}`}
            onClick={() => {
              remove.reset();
              setConfirmingDelete(true);
            }}
            title="Delete goal"
          />
        </PageRows>
        {action.error ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            {action.error.message}
          </p>
        ) : null}
      </PageSection>

      <PageSection title="Details">
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            // A goal that ends when met has nothing to meet without an outcome. Other goals may
            // have none, so the field is only required for this one.
            if (goal.endsWhenMet && !successCriteria.trim()) {
              setCriteriaMissing(true);
              return;
            }
            edit.mutate({
              id: goal.id,
              patch: { title, instruction, successCriteria },
            });
          }}
        >
          <PageCard
            className="mt-4"
            footer={
              <>
                <Button
                  disabled={!changed || edit.isPending}
                  onClick={() => {
                    setTitle(goal.title);
                    setInstruction(goal.instruction);
                    setSuccessCriteria(goal.successCriteria);
                    setCriteriaMissing(false);
                    edit.reset();
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Discard changes
                </Button>
                <Button
                  disabled={!changed || edit.isPending}
                  size="sm"
                  type="submit"
                >
                  {edit.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            }
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-title`}>Name</FieldLabel>
                <Input
                  id={`${formId}-title`}
                  maxLength={160}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  value={title}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-instruction`}>
                  What to do
                </FieldLabel>
                <Textarea
                  id={`${formId}-instruction`}
                  maxLength={6000}
                  onChange={(event) => setInstruction(event.target.value)}
                  required
                  value={instruction}
                />
              </Field>
              <Field data-invalid={criteriaMissing ? true : undefined}>
                {/* As New routine asks it. A goal that ends when met can't leave it empty. */}
                <FieldLabel htmlFor={`${formId}-criteria`}>
                  {goal.endsWhenMet ? "Done when" : "Done when (optional)"}
                </FieldLabel>
                <Textarea
                  aria-invalid={criteriaMissing ? true : undefined}
                  aria-required={goal.endsWhenMet ? true : undefined}
                  id={`${formId}-criteria`}
                  maxLength={3000}
                  onChange={(event) => {
                    setSuccessCriteria(event.target.value);
                    setCriteriaMissing(false);
                  }}
                  value={successCriteria}
                />
                {criteriaMissing ? (
                  <FieldError>
                    It ends when this is met, so say what done looks like.
                  </FieldError>
                ) : null}
              </Field>
            </FieldGroup>
            {edit.error ? (
              <p className="mt-4 text-destructive text-sm" role="alert">
                {edit.error.message}
              </p>
            ) : null}
          </PageCard>
        </form>
      </PageSection>

      {standing.length ? (
        <PageSection title="Where it stands">
          <PageRows>
            {standing.map(({ key, label, icon: Icon, text }, index) => (
              <Fragment key={key}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <Icon />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>{label}</ItemTitle>
                    <RunMarkdown>{text}</RunMarkdown>
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}

      <GoalSchedules
        completed={goal.status === "completed"}
        paused={goal.status === "paused"}
        routines={routines}
      />

      {goal.subscriptions.length > 0 ? (
        <PageSection title="Events">
          <PageRows>
            {goal.subscriptions.map((subscription, index) => (
              <Fragment
                key={`${subscription.source}:${subscription.eventType}`}
              >
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconWebhook />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{describeEvent(subscription)}</ItemTitle>
                    {/* The exact identifier under the words: this is where a person checks it. */}
                    <ItemDescription className="line-clamp-none break-all">
                      {eventIdentifier(subscription)}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}

      <Triggers goal={goal} />
      <Runs channelId={goal.channelId} goalId={goal.id} />

      <Dialog onOpenChange={setConfirmingDelete} open={confirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{goal.title}"?</DialogTitle>
            <DialogDescription>
              {deleteWords(routines)} You can't undo this.
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <DialogBody className="mt-4">
              <p className="text-destructive text-sm" role="alert">
                {remove.error.message}
              </p>
            </DialogBody>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setConfirmingDelete(false)}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(goal.id, {
                  // Usually the route has gone back already, on the list without it. This is
                  // for a list that couldn't be read again.
                  onSuccess: () => navigate({ ...back, replace: true }),
                })
              }
              size="sm"
              type="button"
              variant="destructive"
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

const RUN_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for you",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
};
function runStatusClass(status: string) {
  return status === "failed"
    ? "text-destructive"
    : status === "succeeded"
      ? "text-emerald-600 dark:text-emerald-500"
      : "text-muted-foreground";
}

/**
 * The runs, newest first, polled while the page is open so the one Run now started appears and
 * moves through its states without a reload.
 */
function Runs({ goalId, channelId }: { goalId: string; channelId: string }) {
  const runs = useQuery(responsibilityRunsQueryOptions(goalId));
  return (
    <PageSection title="Runs">
      {runs.isPending ? (
        <LoadingRows className="mt-4" label="Loading its runs" rows={2} />
      ) : runs.error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3" role="alert">
          <p className="text-destructive text-sm">
            Couldn't load its runs. Try again.
          </p>
          <Button
            disabled={runs.isFetching}
            onClick={() => runs.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : runs.data.length ? (
        <PageRows>
          {runs.data.map((run, index) => (
            <Fragment key={run.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconHistory />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className={runStatusClass(run.status)}>
                    {RUN_LABEL[run.status]}
                  </ItemTitle>
                  <ItemDescription>
                    {new Date(run.createdAt).toLocaleString()}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Link
                    className="text-sm underline"
                    params={{ channelId }}
                    to="/channel/$channelId"
                  >
                    Open conversation
                  </Link>
                </ItemActions>
                {run.waiting || run.error || run.replyText ? (
                  <ItemFooter className="min-w-0 flex-col items-stretch">
                    {run.waiting && (
                      <p>
                        Waiting for {run.waiting.kind}. Answer at the top of
                        this Bot's page or in the conversation.
                      </p>
                    )}
                    {run.error && (
                      <p className="text-muted-foreground">{run.error}</p>
                    )}
                    {run.replyText && (
                      <RunMarkdown>{run.replyText}</RunMarkdown>
                    )}
                  </ItemFooter>
                ) : null}
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <p className="mt-4 text-muted-foreground text-sm">No runs yet.</p>
      )}
    </PageSection>
  );
}

/**
 * A Bot's own words, drawn the way the conversation draws them.
 *
 * Progress, the last result and each run's reply are the Bot's markdown, and shown as plain text
 * they read as literal asterisks and backticks. Same renderer and components as the transcript, kept
 * to the row's size: no heading scale, tight paragraph and list spacing.
 */
function RunMarkdown({ children }: { children: string }) {
  return (
    <Streamdown
      className="min-w-0 text-sm [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_li]:my-0 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      components={markdownComponents}
      mode="static"
    >
      {children}
    </Streamdown>
  );
}
