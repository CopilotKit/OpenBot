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
 * Drawn on Settings → Setup, where an admin checks it, and comes back to it after setting a
 * variable and restarting OpenBot. Onboarding leaves it out: none of it blocks the first task.
 *
 * The rows, their sentences and their fixes are the server's (see `lib/setup/queries.ts`): this
 * draws them, and holds the one thing only a browser can do, which is asking it to check again.
 * An admin is handed the page to open or the variables to set; a member is handed neither, because
 * the server never sends them one.
 *
 * NOTHING HERE BLOCKS ANYTHING. A required gap is drawn plainly, in red, and the step around it still
 * lets the person carry on: they cannot set a server's environment from a browser, and keeping them
 * out of the app would not set it either.
 *
 * NO ALARM FOR WHAT A MEMBER CAN'T FIX. A member is told, in one neutral line, that their admin sets
 * a thing up: no amber or red pill, no "Required", and a summary that counts nothing. The pills and
 * the counts are for the admin, who can act on them.
 */
export function SetupChecklist({
  openPage,
}: {
  /**
   * Opens one of the app's own screens. Settings opens it at once. Onboarding has to be finished
   * before any other page opens, so it carries the page to its end and opens it from there.
   */
  openPage: (target: { label: string; path: string }) => void;
}) {
  const checklist = useQuery(setupChecklistQueryOptions());
  const recheck = useMutation(recheckSetupMutationOptions(queryClient));

  /*
   * Check again asks the server to ask Intelligence, the model provider and the computers again,
   * and waits for their answers. A plain refetch is answered from what they last said, and asks
   * again only for the read after it, once an answer failed or is a few minutes old. A checklist
   * that could not be read at all is read again first.
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
        <p className="text-sm text-destructive" role="alert">
          Couldn't check again. Try again.
        </p>
      ) : null}
      {/* Nothing while the first answer is on its way: OpenBot has no loading placeholder. */}
      {checklist.isPending ? null : checklist.error ? (
        <>
          <p className="text-sm text-destructive" role="alert">
            Couldn't check your setup. Check again.
          </p>
          {checkAgain}
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" role="status">
            {checklist.data.audience === "member"
              ? memberSummaryOf(checklist.data.rows)
              : summaryOf(checklist.data.rows)}
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
                  <SetupItem
                    member={checklist.data.audience === "member"}
                    openPage={openPage}
                    row={row}
                  />
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
  /*
   * Says what to do, not only how many: an admin reading "works without them" was left unsure
   * whether to act. Optional gaps are features to add when wanted; required ones come first.
   */
  const optional =
    gaps.length === 1
      ? "1 optional feature isn't set up yet"
      : `${gaps.length} optional features aren't set up yet`;
  const needs =
    required > 0
      ? `${things} setup, and ${required === 1 ? "1 is" : `${required} are`} required. Set up the required ${required === 1 ? "one" : "ones"} first.`
      : `${PRODUCT} is ready to use. ${optional}. Each says how to add it.`;
  return notChecked ? `${needs} ${notChecked}` : needs;
}

/** A member's line over the list: whether anything is left, and who sees to it, without counting. */
export function memberSummaryOf(rows: SetupRow[]): string {
  return rows.every((row) => row.ready)
    ? "Everything is set up."
    : "Your admin sets up anything that isn't ready yet.";
}

/** The pill's words and colours: done green, a gap that blocks red, everything else amber. */
function pillFor(row: SetupRow) {
  if (row.status === "ready")
    return {
      label: "Ready",
      tone: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    };
  if (row.status === "not_checked")
    return {
      label: "Not checked",
      tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    };
  return {
    label: "Needs setup",
    tone: row.required
      ? "bg-destructive/10 text-destructive"
      : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };
}

function SetupItem({
  row,
  member,
  openPage,
}: {
  row: SetupRow;
  /** A member reads a gap as one neutral line, the server's detail, with no pill. */
  member: boolean;
  openPage: (target: { label: string; path: string }) => void;
}) {
  const Icon = ICONS[row.id];
  const pill = member && !row.ready ? null : pillFor(row);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        {/* `line-clamp-none` makes the title a block, so the tag keeps its own space. */}
        <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">
          {row.title}
          {row.required && !member ? (
            <span className="text-xs ms-2 whitespace-nowrap font-normal text-muted-foreground">
              Required
            </span>
          ) : null}
        </ItemTitle>
        <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">
          {row.detail}
        </ItemDescription>
      </ItemContent>
      {pill ? (
        <ItemActions className="shrink-0 self-start">
          <span
            className={cn(
              "text-xs rounded-full px-2 py-0.5 font-medium",
              pill.tone,
            )}
          >
            {pill.label}
          </span>
        </ItemActions>
      ) : null}
      {!row.ready && row.fix ? (
        <ItemFooter className="pl-11">
          <Fix fix={row.fix} openPage={openPage} />
        </ItemFooter>
      ) : null}
    </Item>
  );
}

const LINK =
  "rounded-sm font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring";

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
      <p className="text-sm text-muted-foreground">
        Open {page(fix)}. {fix.docsUrl ? guide(fix.docsUrl) : null}
      </p>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      Set{" "}
      {fix.names.map((name, at) => (
        <Fragment key={name}>
          {at > 0 ? (at === fix.names.length - 1 ? " and " : ", ") : null}
          <code className="text-xs rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground [overflow-wrap:anywhere]">
            {name}
          </code>
        </Fragment>
      ))}
      , then restart {PRODUCT}.
      {fix.page ? <> Or add the key in {page(fix.page)}.</> : null}{" "}
      {guide(fix.docsUrl)}
    </p>
  );
}
