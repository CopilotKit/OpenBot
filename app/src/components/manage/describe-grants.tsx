import {
  IconCircleMinus,
  IconCirclePlus,
  IconHistory,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";
import { DescribeField } from "@/components/boundaries/describe-rule";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import { PageCard, PageRows } from "@/components/layout/page-shell";
import { SharedApprovalFields } from "@/components/plugins/shared-approval-fields";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { saveAppGrantsMutationOptions } from "@/lib/app-grants/mutations";
import {
  type AppGrantReplay,
  appGrantsReplayQueryOptions,
  type ChangedAction,
  type ReplayedAction,
} from "@/lib/app-grants/queries";
import {
  type AppGrantTranslation,
  translateAppGrants,
} from "@/lib/app-grants/translate";
import type { SharedUseApproval } from "@/lib/plugins/shared-use";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/** What came back for one description, kept beside the words it came from. */
type WrittenGrants = AppGrantTranslation & { text: string };

/** How many rows a list shows before it offers the rest. */
const SHOWN = 6;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** What an action does, in the words the page's own sections use. */
function kindOf(action: Pick<ChangedAction, "effect" | "destructive">) {
  if (action.destructive) return "Destroys things";
  return action.effect === "read" ? "Only reads" : "Changes things";
}

/**
 * The change in one sentence, in the order it matters: what goes, then what comes. Exported so the
 * sentence a person reads is assertable without a DOM.
 */
export function changeHeadline(changes: {
  added: readonly unknown[];
  removed: readonly unknown[];
}): string {
  const { added, removed } = changes;
  if (added.length === 0 && removed.length === 0)
    return "This is what the Bot has now. There's nothing to save.";
  const parts = [
    removed.length > 0 ? `turns off ${plural(removed.length, "action")}` : null,
    added.length > 0 ? `turns on ${plural(added.length, "action")}` : null,
  ].filter(Boolean);
  const sentence = parts.join(" and ");
  return `Saving ${sentence}.`;
}

/**
 * The replay in one sentence: "Turns off 2 actions it used and turns on 9 writes it has never used."
 * Exported for the same reason as {@link changeHeadline}.
 */
export function replayHeadline(report: AppGrantReplay): string {
  const parts = [
    report.removedUsed.length > 0
      ? `turns off ${plural(report.removedUsed.length, "action")} it used`
      : null,
    report.refusedGiven.length > 0
      ? `turns on ${plural(report.refusedGiven.length, "action")} it was refused`
      : null,
    report.addedUnusedWrites.length > 0
      ? `turns on ${plural(report.addedUnusedWrites.length, "write")} it has never used`
      : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0)
    return "Turns off nothing it used, and turns on no write it hasn't used.";
  const sentence =
    parts.length > 1
      ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
      : (parts[0] as string);
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** What was replayed, under the headline. */
export function replayWords(report: AppGrantReplay, appTitle: string): string {
  return [
    "Replayed over its last ",
    report.runs > 0 ? `${plural(report.runs, "run")} and ` : "",
    `${plural(report.calls, "call")} to ${appTitle}`,
    report.since ? `, the oldest ${relativeTime(report.since)}.` : ".",
  ].join("");
}

/** One card of actions, a few at a time: a description can turn on thirty of them. */
function ActionRows<T extends ChangedAction>({
  actions,
  icon,
  note,
  verdict,
  verdictClassName,
}: {
  actions: T[];
  icon: React.ReactNode;
  note: (action: T) => string;
  verdict: string;
  verdictClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? actions : actions.slice(0, SHOWN);
  return (
    <>
      <PageRows className="mt-0">
        {shown.map((action, index) => (
          <React.Fragment key={action.ref}>
            <Item size="sm">
              <ItemMedia aria-hidden variant="icon">
                {icon}
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="font-mono text-xs">
                  {action.name}
                </ItemTitle>
                <ItemDescription
                  className={
                    action.destructive ? "text-destructive" : undefined
                  }
                >
                  {note(action)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <span className={`font-medium text-sm ${verdictClassName}`}>
                  {verdict}
                </span>
              </ItemActions>
            </Item>
            {index !== shown.length - 1 && <Separator />}
          </React.Fragment>
        ))}
      </PageRows>
      {actions.length > SHOWN ? (
        <div>
          <Button
            onClick={() => setOpen(!open)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {open ? "Show fewer" : `Show all ${actions.length}`}
          </Button>
        </div>
      ) : null}
    </>
  );
}

const TURNS_OFF = "text-amber-600 dark:text-amber-500";
const TURNS_ON = "text-foreground";

/**
 * "Describe what this Bot can do", on one Bot's page for one app.
 *
 * A sentence in, and the deployment's model picks the app's actions that match it. Beside the set:
 * whether every action is one the app offers, a reading of the set by a call that never saw the
 * sentence, what saving would turn on and off, and what that would have meant for the Bot's own
 * recent calls. Nothing changes until Save, which goes through the same checks as the switches below
 * it and records the sentence.
 */
export function DescribeGrants({
  agentId,
  appKey,
  appTitle,
  botName,
  sharedNeeded,
}: {
  agentId: string;
  appKey: string;
  appTitle: string;
  botName: string;
  /**
   * The audience to offer when the app is Shared and this Bot has no approval for it yet, or null
   * when none is needed. Turning an action on then asks who may use the shared account first, as the
   * switches do.
   */
  sharedNeeded: SharedUseApproval | null;
}) {
  const [written, setWritten] = useState<WrittenGrants | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [approval, setApproval] = useState<SharedUseApproval>({
    audience: "team",
    outsideInput: false,
    members: [],
  });
  const save = useMutation(saveAppGrantsMutationOptions(queryClient));
  const checked = written?.check.ok === true;
  const preview = useQuery({
    ...appGrantsReplayQueryOptions(agentId, appKey, written?.grants ?? []),
    enabled: checked,
  });
  const changes = preview.data?.changes;
  const nothingToSave =
    changes !== undefined &&
    changes.added.length === 0 &&
    changes.removed.length === 0;
  const ready =
    checked && preview.data?.check.ok === true && changes && !nothingToSave;

  const commit = (withApproval?: SharedUseApproval) => {
    if (!ready || !written || !changes) return;
    save.mutate(
      {
        agentId,
        app: appKey,
        add: changes.added.map((action) => action.ref),
        remove: changes.removed.map((action) => action.ref),
        authoring: { source: "english", text: written.text },
        ...(withApproval ? { approval: withApproval } : {}),
      },
      {
        onSuccess: () => {
          setAsking(false);
          setWritten(null);
          setSaved(
            `Saved. ${botName} now has the ${plural(written.grants.length, "action")} you described.`,
          );
        },
      },
    );
  };

  const onSave = () => {
    if (!ready || !changes) return;
    // A Shared app's account is consented to once, before the first action on it, as a switch asks.
    if (sharedNeeded && changes.added.length > 0) {
      setApproval(sharedNeeded);
      setAsking(true);
      return;
    }
    commit();
  };

  return (
    <PageCard
      footer={
        written ? (
          <>
            <Button
              onClick={() => {
                setWritten(null);
                save.reset();
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Discard
            </Button>
            <Button
              disabled={!ready || save.isPending}
              onClick={onSave}
              size="sm"
              type="button"
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </>
        ) : undefined
      }
    >
      <FieldGroup>
        <DescribeField
          action="Choose actions"
          description={`Say in a sentence what ${botName} may do in ${appTitle}, and your model picks the actions. A second reading that never sees your words says what they allow.`}
          id="app-grants-english"
          label={`Describe what ${botName} can do`}
          placeholder="Reads everything and writes drafts, but never sends or deletes"
          write={async (described) => {
            const translation = await translateAppGrants({
              agentId,
              app: appKey,
              text: described,
            });
            save.reset();
            setSaved(null);
            setWritten({ ...translation, text: described });
            return null;
          }}
        />
        {saved && !written ? (
          <p className="text-sm" role="status">
            {saved}
          </p>
        ) : null}
        {written ? (
          <ReadingStatus
            check={written.check}
            edited={null}
            explanation={written.explanation}
            failed="These actions don't check, so OpenBot won't save them."
            heading={`What this lets ${botName} do`}
            passed={`Checks. Every action is one ${appTitle} offers.`}
            warning={written.warning}
          />
        ) : null}
        {checked && preview.error ? (
          <p className="text-destructive text-sm" role="alert">
            {preview.error.message}
          </p>
        ) : null}
        {checked && changes ? (
          <Field aria-labelledby="app-grants-changes" aria-live="polite">
            <FieldLabel id="app-grants-changes">What changes</FieldLabel>
            <FieldDescription>{changeHeadline(changes)}</FieldDescription>
            {changes.removed.length > 0 ? (
              <ActionRows
                actions={changes.removed}
                icon={<IconCircleMinus />}
                note={kindOf}
                verdict="Turns off"
                verdictClassName={TURNS_OFF}
              />
            ) : null}
            {changes.added.length > 0 ? (
              <ActionRows
                actions={changes.added}
                icon={<IconCirclePlus />}
                note={kindOf}
                verdict="Turns on"
                verdictClassName={TURNS_ON}
              />
            ) : null}
          </Field>
        ) : null}
        {checked && preview.data && !nothingToSave ? (
          <RecentUse
            appTitle={appTitle}
            botName={botName}
            report={preview.data.report}
          />
        ) : null}
      </FieldGroup>
      {save.error ? (
        <p className="mt-5 text-destructive text-sm" role="alert">
          {save.error.message}
        </p>
      ) : null}
      {/*
       * Stacked over the card, as the switches' own consent dialog is: the shared account is its own
       * moment. Closing it without allowing leaves everything as it was.
       */}
      <Dialog onOpenChange={(next) => !next && setAsking(false)} open={asking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Let {botName} use the shared {appTitle} account?
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4">
            <SharedApprovalFields onChange={setApproval} value={approval} />
          </DialogBody>
          {save.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setAsking(false)}
              size="sm"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() => commit(approval)}
              size="sm"
            >
              {save.isPending ? "Saving…" : "Allow and save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageCard>
  );
}

/** The change replayed over the Bot's own recent calls to this app. */
function RecentUse({
  report,
  appTitle,
  botName,
}: {
  report: AppGrantReplay | null;
  appTitle: string;
  botName: string;
}) {
  return (
    <Field aria-labelledby="app-grants-replay" aria-live="polite">
      <FieldLabel id="app-grants-replay">
        On {botName}'s recent activity
      </FieldLabel>
      {report === null ? (
        <FieldDescription>
          OpenBot keeps no activity it can read here, so there's nothing to test
          against.
        </FieldDescription>
      ) : report.calls === 0 ? (
        <FieldDescription>
          {report.runs > 0
            ? `${botName} hasn't used ${appTitle} in its last ${plural(report.runs, "run")}, so there's nothing to test against.`
            : `${botName} hasn't used ${appTitle} yet, so there's nothing to test against.`}
          {report.addedUnusedWrites.length > 0
            ? ` This turns on ${plural(report.addedUnusedWrites.length, "write")} it has never used.`
            : ""}
        </FieldDescription>
      ) : (
        <>
          <div>
            <p className="font-medium text-sm">{replayHeadline(report)}</p>
            <FieldDescription className="mt-1">
              {replayWords(report, appTitle)}
            </FieldDescription>
          </div>
          {report.removedUsed.length > 0 ? (
            <ActionRows<ReplayedAction>
              actions={report.removedUsed}
              icon={<IconHistory />}
              note={(action) =>
                `Called ${plural(action.calls, "time")}, last ${relativeTime(action.lastCalled)}.`
              }
              verdict="Turns off"
              verdictClassName={TURNS_OFF}
            />
          ) : null}
          {report.refusedGiven.length > 0 ? (
            <ActionRows<ReplayedAction>
              actions={report.refusedGiven}
              icon={<IconHistory />}
              note={(action) =>
                `Refused ${plural(action.calls, "time")} because it didn't have it, last ${relativeTime(action.lastCalled)}.`
              }
              verdict="Turns on"
              verdictClassName={TURNS_ON}
            />
          ) : null}
        </>
      )}
      {report && report.calls > 0 && report.addedUnusedWrites.length > 0 ? (
        <FieldDescription>
          {`Writes it has never used: ${report.addedUnusedWrites
            .slice(0, 5)
            .map((action) => action.name)
            .join(", ")}${
            report.addedUnusedWrites.length > 5
              ? ` and ${report.addedUnusedWrites.length - 5} more`
              : ""
          }.`}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
