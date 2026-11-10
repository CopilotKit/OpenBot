import {
  IconAlertTriangle,
  IconBan,
  IconDeviceDesktop,
  IconDownload,
  IconEyeOff,
  IconList,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { AskTheTrail, AuditAnswerNote } from "@/components/audit/ask-the-trail";
import type { AuditEvent } from "@/components/audit/audit-cells";
import {
  AuditFilterChips,
  type ChipFilters,
  sameFilters,
  withFilters,
} from "@/components/audit/audit-filters";
import { AuditTable } from "@/components/audit/audit-table";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { explainable, WhyButton } from "@/components/what-if/why-button";
import { useBotNames } from "@/lib/agents/bot-names";
import {
  CALLS_RECORDED_AS_CHANGES,
  COMPUTER_ACTION_EVENT_TYPES,
  DID_NOT_HAPPEN_EVENT_TYPES,
  eventTypeFilter,
  OPENBOT_WORKING_EVENT_TYPES,
  oneRowPerAction,
  REFUSED_EVENT_TYPES,
} from "@/lib/audit/outcome";
import type { AuditAnswer, AuditFilterLabels } from "@/lib/audit/ask";
import {
  auditEventsQueryOptions,
  auditExportUrl,
  auditVocabularyQueryOptions,
} from "@/lib/audit/queries";
import { client } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events.
 */

/*
 * The saved views, built from the same lists the row label and colour are decided by.
 *
 * Written out by hand here and again below, they had already drifted: a refusal on one list and not
 * the other is a row drawn as "Allowed" or a row missing from the view somebody clicks to ask what
 * this deployment refused. See `@/lib/audit/outcome`, which is now the only place either question is
 * answered.
 */
const FILTERS = [
  { label: "Everything", icon: IconList, search: "" },
  {
    label: "Computer actions",
    icon: IconDeviceDesktop,
    search: eventTypeFilter(COMPUTER_ACTION_EVENT_TYPES),
  },
  {
    label: "Blocked",
    icon: IconBan,
    search: eventTypeFilter(REFUSED_EVENT_TYPES),
  },
  {
    label: "Did not happen",
    icon: IconAlertTriangle,
    search: eventTypeFilter(DID_NOT_HAPPEN_EVENT_TYPES),
  },
  {
    label: "Nobody watching",
    icon: IconEyeOff,
    search: "?initiatorKind=routine,handoff,responsibility,memory",
  },
] as const;

/** A saved view's query with one Bot's rows asked for too, for the table and the export alike. */
export function withBot(search: string, bot: string | undefined): string {
  if (!bot) return search;
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  params.set("bot", bot);
  return `?${params.toString()}`;
}

/**
 * A view's query as the personal edition's Activity asks it: without OpenBot's own working, asked of
 * the server so the page still holds a full page of rows. The export asks the same, so the file is
 * the table.
 */
export function withoutOpenBotWorking(search: string): string {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  params.set("excludeEventType", OPENBOT_WORKING_EVENT_TYPES.join(","));
  // A Routines call whose routine change has its own row: one action, drawn once.
  params.set("excludeCalls", CALLS_RECORDED_AS_CHANGES.join(","));
  return `?${params.toString()}`;
}

/**
 * Each row about a skill with the title the skill's page shows, so "Give a Bot a skill" names
 * "Write a skill" and not `skill-creator`, on rows written before and after. A skill since deleted
 * has no title to find, and reads as its slug in words.
 */
function withSkillTitles(
  events: AuditEvent[],
  skills: readonly { slug: string; title: string }[] | undefined,
): AuditEvent[] {
  if (!skills?.length) return events;
  const titles = new Map(skills.map((skill) => [skill.slug, skill.title]));
  return events.map((event) => {
    const title =
      event.targetType === "skill" && event.targetId
        ? titles.get(event.targetId)
        : undefined;
    return title ? { ...event, subjectTitle: title } : event;
  });
}

/** Admin's "Why?" on a row one of OpenBot's controls decided: see `what-if/why-button.tsx`. */
const whyFor = (event: AuditEvent) =>
  explainable(event) ? <WhyButton event={event} /> : null;

/** What the page says under its title in Admin, where an admin reviews every Bot against policy. */
const ADMIN_DESCRIPTION =
  "Review Bot actions and actions blocked by this deployment’s policy.";

/**
 * `children` are sections only the team edition's Admin adds below the page's own (the admin's
 * controls for these). The personal edition's Settings renders this page with none, and with its
 * own `description`, because a page anybody can open does not talk about a deployment.
 *
 * `bot` narrows every view to one Bot's rows, asked of the server; `onClearBot` takes it off.
 */
const NO_LABELS: AuditFilterLabels = {
  bots: {},
  people: {},
  apps: {},
  rules: {},
};

export function AuditPage({
  ask = false,
  bot,
  children,
  description = ADMIN_DESCRIPTION,
  onClearBot,
}: {
  /**
   * Admin's Ask and its filter chips: questions in English, and the trail's own filters by app,
   * tool, effect, action and rule. The personal edition's Activity has neither.
   */
  ask?: boolean;
  bot?: string;
  children?: ReactNode;
  description?: string;
  onClearBot?: () => void;
} = {}) {
  const paths = useManagePaths();
  const [view, setView] = useState<string>(FILTERS[0].search);
  /*
   * Admin's filters, as chips: asked of the server beside the view, from an answer or added by hand.
   * A Bot's own Activity page links here with `bot`, which arrives as that Bot's chip, so the one Bot
   * filter there is the chip, and taking it off takes it out of the address too.
   */
  const [chips, setChipState] = useState<ChipFilters>(() =>
    ask && bot ? { bot } : {},
  );
  useEffect(() => {
    if (ask && bot)
      setChipState((current) =>
        current.bot === bot ? current : { ...current, bot },
      );
  }, [ask, bot]);
  const setChips = (next: ChipFilters) => {
    setChipState(next);
    if (bot && next.bot !== bot) onClearBot?.();
  };
  const [answer, setAnswer] = useState<
    (AuditAnswer & { question: string }) | null
  >(null);
  // This deployment's Bots, apps and rules, asked for the first time a chip menu opens.
  const [vocabularyWanted, setVocabularyWanted] = useState(false);
  const vocabulary = useQuery({
    ...auditVocabularyQueryOptions(),
    enabled: ask && vocabularyWanted,
  }).data;
  // The stored event names and OpenBot's own working are Admin's to read; the personal edition's
  // Activity is anybody's page. Its route has the edition loaded before this draws.
  const edition = useQuery(deploymentCapabilitiesQueryOptions()).data?.edition;
  const asked = ask ? withFilters(view, chips) : withBot(view, bot);
  const search = edition === "personal" ? withoutOpenBotWorking(asked) : asked;
  const [query, setQuery] = useState("");
  // A page at a time, newest first; "Show older events" under the last row asks for the next.
  /*
   * The rows already shown stay while the next filters' rows load, so the toolbar and the chip menu
   * open in it are not taken down and drawn again on every tick. Only the first load draws nothing.
   */
  const events = useInfiniteQuery({
    ...auditEventsQueryOptions(search),
    placeholderData: keepPreviousData,
  });
  // Activity names a skill by the title its page shows; the trail keeps only its slug.
  const skills = useQuery({
    ...pluginsPageQueryOptions(),
    enabled: edition === "personal",
  }).data?.skills;
  const rows = withSkillTitles(
    oneRowPerAction(events.data?.pages.flatMap((page) => page.events) ?? []),
    skills,
  );
  const nameFor = useBotNames();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportCapped, setExportCapped] = useState<number | null>(null);

  /*
   * The same filtered query as the table, downloaded as a file. The server walks every
   * matching page up to its cap, so this stays a single request no matter how many pages
   * the filter matches; the filename carries the day it was pulled.
   */
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportCapped(null);
    try {
      const response = await client(auditExportUrl(search), {
        fallback: "Couldn't export these events. Try again.",
      });
      // A file that stopped early must say so, or it reads as the whole trail.
      const capped = Number(response.headers.get("x-audit-export-truncated"));
      if (Number.isInteger(capped) && capped > 0) setExportCapped(capped);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `audit-events-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(
        error instanceof Error
          ? error.message
          : "Couldn't export these events. Try again.",
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    /*
     * THE ONE FULL-WIDTH PAGE IN ADMIN, and the one that keeps a table. The page is the window's
     * height; the title stays put and the rows scroll inside the log. With recording controls
     * below it, the log is bounded so the page can scroll down to those controls too.
     */
    <PageShell description={description} title={paths.auditLabel} width="full">
      {/* With admin settings below the log, the page scrolls and the log keeps its own bounded
          viewport. Without settings, the table fills the panel as before. */}
      <div className={children ? "min-h-0 flex-1 overflow-y-auto" : "contents"}>
        <div
          className={children ? "flex h-[60vh] min-h-80 flex-col" : "contents"}
        >
          {/*
           * Above the table rather than in its toolbar: a question being typed and its answer outlast
           * anything the table draws again. The answer's chips are the toolbar's, beside the search.
           */}
          {ask ? (
            <div className="flex shrink-0 flex-col gap-2 px-4 pb-3">
              <AskTheTrail
                onAnswer={(next) => {
                  setAnswer(next);
                  // The answer is the whole question, so it starts from every event. One the trail
                  // can't give clears the chips too, so no earlier filters stand under it as its rows.
                  setView(FILTERS[0].search);
                  setChips(next.filters);
                }}
              />
              {answer ? (
                <AuditAnswerNote
                  answer={answer}
                  edited={
                    answer.answerable !== "no" &&
                    !sameFilters(chips, answer.filters)
                  }
                />
              ) : null}
            </div>
          ) : null}
          {events.isPending ? null : events.isError &&
            !events.isFetchNextPageError ? (
            <p className="px-4 text-destructive text-sm" role="alert">
              Couldn't load these events. Reload the page.
            </p>
          ) : (
            <AuditTable
              deploymentName={paths.deploymentName}
              events={rows}
              footer={
                events.hasNextPage ? (
                  <div className="flex flex-col items-center gap-2 py-3">
                    {events.isFetchNextPageError ? (
                      <p className="text-destructive text-sm" role="alert">
                        Couldn't load older events. Try again.
                      </p>
                    ) : null}
                    <Button
                      disabled={events.isFetchingNextPage}
                      onClick={() => events.fetchNextPage()}
                      size="sm"
                      variant="outline"
                    >
                      {events.isFetchingNextPage
                        ? "Loading…"
                        : "Show older events"}
                    </Button>
                  </div>
                ) : null
              }
              moreToLoad={events.hasNextPage}
              nameFor={nameFor}
              query={query}
              storedNames={edition !== "personal"}
              {...(ask ? { rowAction: whyFor } : {})}
              toolbar={({ count, filters }) => (
                <div className="flex shrink-0 flex-col gap-3 border-border border-b px-4 pb-3">
                  {/*
                   * The saved views are one control with one answer, so they are drawn as a segmented
                   * group: the pressed one is filled, the rest sit flat inside the same outline.
                   */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground text-xs">View</span>
                    <fieldset
                      aria-label="View"
                      className="inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5"
                    >
                      {FILTERS.map((filter) => {
                        const active = view === filter.search;
                        return (
                          <Button
                            aria-pressed={active}
                            className={cn(
                              "h-6 px-2 font-normal",
                              active
                                ? "bg-muted text-foreground"
                                : "text-muted-foreground",
                            )}
                            key={filter.label}
                            onClick={() => setView(filter.search)}
                            size="xs"
                            type="button"
                            variant="ghost"
                          >
                            <filter.icon />
                            {filter.label}
                          </Button>
                        );
                      })}
                    </fieldset>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative w-64">
                      <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        aria-label="Search events"
                        className="h-8 pl-8"
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search events…"
                        type="search"
                        value={query}
                      />
                    </div>
                    {/* Beside the other filters, on the row that wraps: it narrows what is asked for. */}
                    {bot && !ask ? (
                      <Button
                        aria-label={`Show every Bot, not only ${nameFor(bot)}`}
                        onClick={onClearBot}
                        size="sm"
                        variant="outline"
                      >
                        Only {nameFor(bot)}
                        <IconX />
                      </Button>
                    ) : null}
                    {/*
                     * Admin's one set of filters: the answer's chips and Add filter, asked of the
                     * server. Anywhere else, the buttons that narrow the rows already loaded.
                     */}
                    {ask ? (
                      <AuditFilterChips
                        filters={chips}
                        labels={answer?.labels ?? NO_LABELS}
                        nameFor={nameFor}
                        onChange={setChips}
                        onOpen={() => setVocabularyWanted(true)}
                        vocabulary={vocabulary}
                      />
                    ) : (
                      filters
                    )}
                    <span
                      className="ml-1 text-muted-foreground text-xs tabular-nums"
                      data-audit-count
                    >
                      {count}
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <Button
                        onClick={() => events.refetch()}
                        size="sm"
                        variant="outline"
                      >
                        <IconRefresh />
                        Refresh
                      </Button>
                      <Button
                        disabled={exporting}
                        onClick={exportCsv}
                        size="sm"
                        variant="outline"
                      >
                        <IconDownload />
                        {exporting ? "Exporting…" : "Export CSV"}
                      </Button>
                    </div>
                  </div>
                  {exportError ? (
                    <p className="text-destructive text-sm" role="alert">
                      {exportError}
                    </p>
                  ) : null}
                  {exportCapped ? (
                    <p className="text-muted-foreground text-sm" role="status">
                      The file has the newest {exportCapped.toLocaleString()}{" "}
                      events, not all of them. Narrow the filter or dates to
                      export the rest.
                    </p>
                  ) : null}
                  {rows.length === 0 ? (
                    <PageEmpty icon={IconSearch} title="No matches">
                      No events match this filter yet.
                    </PageEmpty>
                  ) : null}
                </div>
              )}
            />
          )}
        </div>
        {children ? <div className="px-4 pb-16">{children}</div> : null}
      </div>
    </PageShell>
  );
}
