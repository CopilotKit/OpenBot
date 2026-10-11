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
import { Link } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import { Streamdown } from "streamdown";
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
  type ResponsibilityRecord,
  responsibilityActionMutationOptions,
  responsibilityRunsQueryOptions,
  type TriggerRecord,
  triggersQueryOptions,
  updateResponsibilityMutationOptions,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";
import { KIND_LABEL, Triggers } from "./triggers";

type Status = ResponsibilityRecord["status"];
type Source = ResponsibilityRecord["subscriptions"][number]["source"];

/** A responsibility's state, as a word and as the mark its row leads with. */
export const STATUS: Record<
  Status,
  { label: string; icon: typeof IconTarget }
> = {
  active: { label: "Active", icon: IconTarget },
  paused: { label: "Paused", icon: IconPlayerPause },
  completed: { label: "Completed", icon: IconCircleCheck },
};

const SOURCE_LABEL: Record<Source, string> = {
  manual: "Manual",
  slack: "Slack",
  github: "GitHub",
  schedule: "Schedule",
  connector: "Connected app",
  webhook: "Webhook",
  linear: "Linear",
  sentry: "Sentry",
  pagerduty: "PagerDuty",
  email: "Email",
};

/**
 * What a responsibility's row says under its title: its state, and while it is active, what starts
 * it. Computed from the queries on every render so it follows whatever the dialog just changed.
 *
 * `triggers` is undefined until they load, and then nothing is said about what starts it rather than
 * "Runs when asked", which would be a claim about triggers nobody has read yet.
 */
export function summaryFor(
  goal: ResponsibilityRecord,
  triggers: TriggerRecord[] | undefined,
): string {
  const status = STATUS[goal.status].label;
  if (goal.status === "completed") return status;
  if (goal.status === "paused")
    return `${status} · Nothing starts it until resumed`;
  const starts = [
    ...goal.subscriptions.map(
      (subscription) =>
        `${SOURCE_LABEL[subscription.source]} ${subscription.eventType}`,
    ),
    ...(triggers ?? [])
      .filter((trigger) => trigger.enabled)
      .map((trigger) => `${KIND_LABEL[trigger.kind]} trigger`),
  ];
  if (starts.length) return `${status} · Starts on ${starts.join(", ")}`;
  return triggers ? `${status} · Runs when asked` : status;
}

/**
 * Everything about one responsibility, opened from its row: what can be done to it now (pause, run,
 * complete — each immediate), its wording (a draft, saved by the footer), where it stands, what
 * starts it, and its runs.
 */
export function ResponsibilityDialog({
  goal,
  onClose,
}: {
  goal: ResponsibilityRecord;
  onClose: () => void;
}) {
  const formId = useId();
  const [showRuns, setShowRuns] = useState(false);
  const [title, setTitle] = useState(goal.title);
  const [instruction, setInstruction] = useState(goal.instruction);
  const [successCriteria, setSuccessCriteria] = useState(goal.successCriteria);
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const action = useMutation(responsibilityActionMutationOptions(queryClient));
  const edit = useMutation(updateResponsibilityMutationOptions(queryClient));
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
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{goal.title}</DialogTitle>
          <DialogDescription>
            {summaryFor(goal, triggers.data)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <div className="overflow-hidden rounded-lg">
            {goal.status !== "completed" ? (
              <>
                <Item size="sm" variant="muted">
                  <ItemMedia variant="icon">
                    <IconTarget />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>Active</ItemTitle>
                    <ItemDescription>
                      {goal.status === "active"
                        ? "Its events and triggers start runs."
                        : "Paused. Its triggers are acknowledged but never run it."}
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
                      onClick={() => {
                        setShowRuns(true);
                        action.mutate({ id: goal.id, action: "run" });
                      }}
                      type="button"
                    />
                  }
                  size="sm"
                  variant="muted"
                >
                  <ItemMedia variant="icon">
                    <IconPlayerPlay />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>Run now (real run)</ItemTitle>
                    <ItemDescription>
                      Runs it for real, now: the Bot does the work and can post
                      and act.
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
                  variant="muted"
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
              variant="muted"
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
          </div>
          {action.error || edit.error ? (
            <p role="alert" className="text-destructive text-sm">
              {action.error?.message ?? edit.error?.message}
            </p>
          ) : null}

          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              edit.mutate(
                {
                  id: goal.id,
                  patch: { title, instruction, successCriteria },
                },
                { onSuccess: onClose },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-title`}>Title</FieldLabel>
                <Input
                  id={`${formId}-title`}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={160}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-instruction`}>
                  Instruction
                </FieldLabel>
                <Textarea
                  id={`${formId}-instruction`}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  required
                  maxLength={6000}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-criteria`}>
                  Success criteria
                </FieldLabel>
                <Textarea
                  id={`${formId}-criteria`}
                  value={successCriteria}
                  onChange={(event) => setSuccessCriteria(event.target.value)}
                  required
                  maxLength={3000}
                />
              </Field>
            </FieldGroup>
          </form>

          {standing.length || goal.subscriptions.length ? (
            <div className="overflow-hidden rounded-lg">
              {standing.map(({ key, label, icon: Icon, text }, index) => (
                <Fragment key={key}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm" variant="muted">
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
              {goal.subscriptions.length > 0 ? (
                <>
                  {standing.length ? <Separator /> : null}
                  <Item size="sm" variant="muted">
                    <ItemMedia variant="icon">
                      <IconWebhook />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>Events</ItemTitle>
                      <ItemDescription className="line-clamp-none">
                        {goal.subscriptions
                          .map(
                            (subscription) =>
                              `${subscription.source} · ${subscription.eventType}`,
                          )
                          .join(", ")}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                </>
              ) : null}
            </div>
          ) : null}

          <Triggers goal={goal} />
          <Runs
            channelId={goal.channelId}
            goalId={goal.id}
            onToggle={() => setShowRuns(!showRuns)}
            shown={showRuns}
          />
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={edit.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {edit.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
 * The runs, fetched only once somebody asks for them — or presses Run now, which opens them so the
 * run it started is there to watch.
 */
function Runs({
  goalId,
  channelId,
  shown,
  onToggle,
}: {
  goalId: string;
  channelId: string;
  shown: boolean;
  onToggle: () => void;
}) {
  const runs = useQuery({
    ...responsibilityRunsQueryOptions(goalId),
    enabled: shown,
  });
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-sm">Runs</h3>
        <Button onClick={onToggle} size="sm" type="button" variant="ghost">
          {shown ? "Hide runs" : "View runs"}
        </Button>
      </div>
      {!shown ? null : runs.isPending ? null : runs.error ? (
        <p role="alert" className="text-destructive text-sm">
          {runs.error.message}
        </p>
      ) : runs.data.length ? (
        <div className="overflow-hidden rounded-lg">
          {runs.data.map((run, index) => (
            <Fragment key={run.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm" variant="muted">
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
                    to="/channel/$channelId"
                    params={{ channelId }}
                    className="text-sm underline"
                  >
                    Open thread
                  </Link>
                </ItemActions>
                {run.waiting || run.error || run.replyText ? (
                  <ItemFooter className="min-w-0 flex-col items-stretch">
                    {run.waiting && (
                      <p>
                        Waiting for {run.waiting.kind}. Respond at the top of
                        this Bot's page, or in the conversation.
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
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No runs yet.</p>
      )}
    </section>
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
