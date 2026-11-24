import {
  IconAlertTriangle,
  IconCalendarTime,
  IconCircleCheck,
  IconHistory,
  IconLoader2,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  restoreComputerMutationOptions,
  restoreSettled,
} from "@/lib/computers/mutations";
import {
  type ComputerRestoreRun,
  type ComputerSnapshot,
  type ComputerSnapshots,
  workspaceSnapshotsQueryOptions,
} from "@/lib/computers/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { failureSaid } from "@/lib/load-failure";

/**
 * A computer's saved copies, on a Bot's Computer page, and restoring one.
 *
 * OpenBot saves each computer's files and browser sign-ins once a day and keeps the last 7, and saves
 * it again just before every restore. Nothing is ever restored unless a person picks a copy and
 * confirms it here: an automatic restore from an old copy loses the work done since, so the screen
 * never picks one for them either.
 */

/** When a copy was saved, as a person reads a date: "Saturday, November 21 at 3:00 AM" in en-US. */
export function copyDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A copy's name in a list: its date, or for the one saved before a restore, that it was. */
export function copyLabel(snapshot: ComputerSnapshot): string {
  return snapshot.kind === "before-restore"
    ? `Before restore, ${copyDate(snapshot.takenAt)}`
    : copyDate(snapshot.takenAt);
}

const SECTION_DESCRIPTION =
  "OpenBot saves this computer's files and browser sign-ins once a day and keeps the last 7. Restoring a copy puts the computer back the way it was then.";

/**
 * The section on a Bot's Computer page: the copies of the computer this Bot runs on for the person
 * reading. Drawn only where this OpenBot keeps copies and the person may see them; a refusal or
 * `available: false` draws nothing at all.
 */
export function WorkspaceSnapshotsSection({
  botId,
  enabled = true,
}: {
  botId: string;
  /** False until the page knows this OpenBot has computers for Bots. */
  enabled?: boolean;
}) {
  const snapshots = useQuery({
    ...workspaceSnapshotsQueryOptions(botId),
    enabled,
  });
  const data = snapshots.data;
  if (!data?.available) return null;
  return (
    <PageSection description={SECTION_DESCRIPTION} title="Saved copies">
      <SnapshotsBody botId={botId} data={data} />
    </PageSection>
  );
}

/**
 * An admin's look at another person's computer this Bot runs on: its copies in a dialog, each with
 * Restore, confirmed in a second dialog over it with the same words the person's own section uses.
 */
export function RestoreComputerDialog({
  botId,
  computer,
  name,
  onOpenChange,
  open,
}: {
  botId: string;
  /** Whose computer, as `person:<id>` or `bot:<id>`. */
  computer: string;
  /** Whose it is, as the list names it: "Dana Whitfield's computer". */
  name: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const snapshots = useQuery({
    ...workspaceSnapshotsQueryOptions(botId, computer),
    enabled: open,
  });
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>{SECTION_DESCRIPTION}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          {snapshots.isPending ? null : snapshots.error ? (
            <p className={DESTRUCTIVE_NOTICE} role="alert">
              {failureSaid(snapshots.error)}
            </p>
          ) : !snapshots.data.available ? (
            <p className="text-muted-foreground text-sm">
              This OpenBot doesn't keep saved copies of computers.
            </p>
          ) : (
            <SnapshotsBody
              botId={botId}
              computer={computer}
              data={snapshots.data}
              inDialog
            />
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The destructive notice the Computer page uses for a refusal. */
const DESTRUCTIVE_NOTICE =
  "rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm";

/** The latest restore, said once above the copies, and the copies with Restore where allowed. */
function SnapshotsBody({
  botId,
  computer,
  data,
  inDialog = false,
}: {
  botId: string;
  computer?: string;
  data: ComputerSnapshots;
  /** Inside a dialog the rows are filled, since a card's colour is the dialog's own. */
  inDialog?: boolean;
}) {
  const restoring = data.restore?.state === "running";
  useSettledRestore(botId, data.restore);

  const restore = useMutation(restoreComputerMutationOptions(queryClient));
  /*
   * Kept while the dialog fades out, so its title doesn't fall back to an empty date on the way:
   * closing only closes, and the next Restore replaces what it names.
   */
  const [asking, setAsking] = useState<{
    snapshot: ComputerSnapshot;
    open: boolean;
  } | null>(null);
  const close = () =>
    setAsking((current) => (current ? { ...current, open: false } : null));

  const confirm = () => {
    if (!asking) return;
    restore.mutate(
      {
        botId,
        snapshotId: asking.snapshot.id,
        ...(computer ? { computer } : {}),
      },
      { onSuccess: close },
    );
  };

  const row = (snapshot: ComputerSnapshot) => (
    <Item size="sm" variant={inDialog ? "muted" : "default"}>
      <ItemMedia variant="icon">
        {snapshot.kind === "before-restore" ? (
          <IconHistory />
        ) : (
          <IconCalendarTime />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{copyLabel(snapshot)}</ItemTitle>
        <ItemDescription>
          {snapshot.kind === "before-restore"
            ? "Saved just before a restore."
            : "Saved automatically."}
        </ItemDescription>
      </ItemContent>
      {data.canRestore ? (
        <ItemActions>
          <Button
            disabled={restoring || restore.isPending}
            onClick={() => {
              restore.reset();
              setAsking({ snapshot, open: true });
            }}
            size="sm"
            variant="outline"
          >
            Restore
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );

  return (
    <>
      {data.restore ? (
        <RestoreStatus
          // A dialog's body spaces its own blocks; on the page the notice sits under the heading.
          className={inDialog ? undefined : "mt-4"}
          restore={data.restore}
          snapshots={data.snapshots}
        />
      ) : null}

      {data.snapshots.length === 0 ? (
        <PageEmpty icon={IconHistory} title="No saved copies yet">
          OpenBot saves the first one within a day.
        </PageEmpty>
      ) : inDialog ? (
        <ItemGroup>
          {data.snapshots.map((snapshot) => (
            <Fragment key={snapshot.id}>{row(snapshot)}</Fragment>
          ))}
        </ItemGroup>
      ) : (
        <PageRows>
          {data.snapshots.map((snapshot, index) => (
            <Fragment key={snapshot.id}>
              {row(snapshot)}
              {index !== data.snapshots.length - 1 && <Separator />}
            </Fragment>
          ))}
        </PageRows>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) close();
        }}
        open={asking?.open === true}
      >
        <DialogContent overlayClassName={inDialog ? "bg-black/30" : undefined}>
          <DialogHeader>
            <DialogTitle>
              Restore from {asking ? copyDate(asking.snapshot.takenAt) : ""}?
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 flex flex-col gap-3 text-sm">
            <p>
              Every file and browser sign-in on this computer goes back to how
              it was then, for every Bot that runs on it. Anything that changed
              since is replaced.
            </p>
            <p>
              OpenBot first saves the computer as it is now, listed as “Before
              restore”, so you can undo this. The computer restarts, and
              routines wait until it's back.
            </p>
          </DialogBody>
          <DialogFooter className="mt-4 flex-wrap">
            {restore.error ? (
              <p
                className="mr-auto min-w-0 flex-1 basis-48 text-destructive text-sm"
                role="alert"
              >
                {failureSaid(restore.error)}
              </p>
            ) : null}
            <Button onClick={close} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button disabled={restore.isPending} onClick={confirm} size="sm">
              {restore.isPending ? "Restoring…" : "Restore it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** How the latest restore stands: under way, back, or why it failed. */
function RestoreStatus({
  className,
  restore,
  snapshots,
}: {
  className?: string;
  restore: ComputerRestoreRun;
  snapshots: ComputerSnapshot[];
}) {
  const when = copyDate(restore.snapshotTakenAt);
  if (restore.state === "running")
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm",
          className,
        )}
        role="status"
      >
        <IconLoader2
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
        <p>
          Restoring this computer to how it was on {when}. Bots on it wait until
          it's back, in a few minutes.
        </p>
      </div>
    );
  if (restore.state === "failed")
    return (
      <div
        className={cn("flex items-start gap-2", DESTRUCTIVE_NOTICE, className)}
        role="alert"
      >
        <IconAlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-destructive"
        />
        <p>
          {restore.error ??
            "Couldn't restore this computer. It's as it was before. Try again in a moment."}
        </p>
      </div>
    );
  // The copy saved just before is pointed at only while it is still listed.
  const before = snapshots.some(
    (snapshot) => snapshot.id === restore.beforeSnapshotId,
  );
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-muted-foreground text-sm",
        className,
      )}
    >
      <IconCircleCheck
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-success"
      />
      <span>
        Restored to how it was on {when}.
        {before
          ? " The copy saved just before is listed as “Before restore”, if you want it back."
          : ""}
      </span>
    </p>
  );
}

/**
 * When a restore this screen watched ends, the computer was stopped and started again: what the page
 * knows about whether it runs is read again.
 */
function useSettledRestore(botId: string, restore: ComputerRestoreRun | null) {
  const state = restore?.state;
  const was = useRef(state);
  useEffect(() => {
    if (was.current === "running" && state !== undefined && state !== "running")
      void restoreSettled(queryClient, botId);
    was.current = state;
  }, [botId, state]);
}
