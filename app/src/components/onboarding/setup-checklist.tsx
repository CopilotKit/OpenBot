import {
  IconApps,
  IconBrain,
  IconDeviceDesktop,
  IconMessages,
  IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
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
import { appConfig } from "@/lib/generated/application-config";
import { recheckSetupMutationOptions } from "@/lib/setup/mutations";
import {
  type SetupFix,
  type SetupRow,
  type SetupRowId,
  setupChecklistQueryOptions,
} from "@/lib/setup/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

const ICONS: Record<SetupRowId, typeof IconBrain> = {
  intelligence: IconBrain,
  model: IconSparkles,
  computer: IconDeviceDesktop,
  apps: IconApps,
  chat: IconMessages,
};

const PRODUCT = appConfig.brand.productName;

/**
 * What this deployment has, and what still needs setting up: one row each, with a pill saying
 * Ready, Not checked or Needs setup.
 *
 * The rows, their sentences and their fixes are the server's (see `lib/setup/queries.ts`): this
 * draws them, and holds the one thing only a browser can do, which is asking it to check again.
 * An admin is handed the page to open or the variables to set; a member is handed neither, because
 * the server never sends them one.
 *
 * NOTHING HERE BLOCKS ANYTHING. A required gap is drawn plainly, in red, and the step around it still
 * lets the person carry on: they cannot set a server's environment from a browser, and keeping them
 * out of the app would not set it either.
 */
export function SetupChecklist({
  openPage,
}: {
  /**
   * Opens one of the app's own screens. Onboarding has to be finished before any other page opens,
   * so it carries the page to its last step and opens it from there.
   */
  openPage: (target: { label: string; path: string }) => void;
}) {
  const checklist = useQuery(setupChecklistQueryOptions());
  const recheck = useMutation(recheckSetupMutationOptions(queryClient));

  /*
   * Check again asks the server to ask Intelligence, the model provider and the computers again,
   * which a plain refetch would not: those answers are kept from the last time they were asked. A
   * checklist that could not be read at all is read again first.
   */
  const checking = checklist.isFetching || recheck.isPending;
  const checkAgain = (
    <Button
      className="self-center lg:self-start"
      disabled={checking}
      onClick={() => {
        if (checklist.error) void checklist.refetch();
        else recheck.mutate();
      }}
      size="sm"
      variant="ghost"
    >
      {checking ? "Checking…" : "Check again"}
    </Button>
  );

  return (
    <div className="flex w-full flex-col gap-3" data-setup-checklist="">
      {recheck.error ? (
        <p className="type-sub text-destructive" role="alert">
          Couldn't check again. Try again.
        </p>
      ) : null}
      {checklist.isPending ? null : checklist.error ? (
        <>
          <p className="type-sub text-destructive" role="alert">
            Couldn't check your setup. Check again, or carry on and look later.
          </p>
          {checkAgain}
        </>
      ) : (
        <>
          <p className="type-sub text-muted-foreground" role="status">
            {summaryOf(checklist.data.rows)}
          </p>
          <PageRows className="mt-0">
            <ul aria-label="Setup">
              {checklist.data.rows.map((row, at) => (
                <li
                  data-ready={row.ready ? "" : undefined}
                  data-setup-row={row.id}
                  data-status={row.status}
                  key={row.id}
                >
                  {at > 0 ? <Separator /> : null}
                  <SetupItem openPage={openPage} row={row} />
                </li>
              ))}
            </ul>
          </PageRows>
          {checkAgain}
        </>
      )}
    </div>
  );
}

/** One line over the list, so the state of the whole list is said before its rows are read. */
export function summaryOf(rows: SetupRow[]): string {
  const gaps = rows.filter((row) => row.status === "needs_setup");
  const unchecked = rows.filter((row) => row.status === "not_checked").length;
  const notChecked =
    unchecked === 0
      ? null
      : unchecked === 1
        ? "1 thing isn't checked yet."
        : `${unchecked} things aren't checked yet.`;
  if (gaps.length === 0) return notChecked ?? "Everything is set up.";
  const required = gaps.filter((row) => row.required).length;
  const things =
    gaps.length === 1 ? "1 thing needs" : `${gaps.length} things need`;
  const needs =
    required > 0
      ? `${things} setup, and ${required === 1 ? "1 is" : `${required} are`} required.`
      : `${things} setup. ${PRODUCT} works without ${gaps.length === 1 ? "it" : "them"}.`;
  return notChecked ? `${needs} ${notChecked}` : needs;
}

/** The pill's words and colours: done green, a gap that blocks red, everything else amber. */
function pillFor(row: SetupRow) {
  if (row.status === "ready")
    return { label: "Ready", tone: "bg-status-done-soft text-status-done" };
  if (row.status === "not_checked")
    return {
      label: "Not checked",
      tone: "bg-status-needs-soft text-status-needs",
    };
  return {
    label: "Needs setup",
    tone: row.required
      ? "bg-status-problem-soft text-status-problem"
      : "bg-status-needs-soft text-status-needs",
  };
}

function SetupItem({
  row,
  openPage,
}: {
  row: SetupRow;
  openPage: (target: { label: string; path: string }) => void;
}) {
  const Icon = ICONS[row.id];
  const pill = pillFor(row);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        {/* `line-clamp-none` makes the title a block, so the tag keeps its own space. */}
        <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">
          {row.title}
          {row.required ? (
            <span className="type-caption ms-2 whitespace-nowrap font-normal text-muted-foreground">
              Required
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">
          {row.detail}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0 self-start">
        <span
          className={cn(
            "type-caption rounded-full px-2 py-0.5 font-medium",
            pill.tone,
          )}
        >
          {pill.label}
        </span>
      </ItemActions>
      {!row.ready && row.fix ? (
        <ItemFooter className="pl-11">
          <Fix fix={row.fix} openPage={openPage} />
        </ItemFooter>
      ) : null}
    </Item>
  );
}

const LINK =
  "rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** How to close one gap: a page to open, or the variables to set and a guide. */
function Fix({
  fix,
  openPage,
}: {
  fix: SetupFix;
  openPage: (target: { label: string; path: string }) => void;
}) {
  const page = (target: { label: string; path: string }) => (
    <a
      className={LINK}
      href={target.path}
      onClick={(event) => {
        event.preventDefault();
        openPage(target);
      }}
    >
      {target.label}
    </a>
  );
  const guide = (url: string) => (
    <a className={LINK} href={url} rel="noopener noreferrer" target="_blank">
      Setup guide
    </a>
  );

  if (fix.kind === "page") {
    return (
      <p className="type-sub text-muted-foreground">
        Open {page(fix)}. {fix.docsUrl ? guide(fix.docsUrl) : null}
      </p>
    );
  }

  return (
    <p className="type-sub text-muted-foreground">
      Set{" "}
      {fix.names.map((name, at) => (
        <Fragment key={name}>
          {at > 0 ? (at === fix.names.length - 1 ? " and " : ", ") : null}
          <code className="type-caption rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground [overflow-wrap:anywhere]">
            {name}
          </code>
        </Fragment>
      ))}
      , then restart {PRODUCT}.
      {fix.page ? <> Or add one in {page(fix.page)}.</> : null}{" "}
      {guide(fix.docsUrl)}
    </p>
  );
}
