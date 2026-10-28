import {
  IconAlertTriangle,
  IconBan,
  IconDeviceDesktop,
  IconDownload,
  IconEyeOff,
  IconList,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { AuditEvent } from "@/components/audit/audit-cells";
import { AuditTable } from "@/components/audit/audit-table";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBotNames } from "@/lib/agents/bot-names";
import {
  DID_NOT_HAPPEN_EVENT_TYPES,
  eventTypeFilter,
  REFUSED_EVENT_TYPES,
} from "@/lib/audit/outcome";
import { auditEventsQueryOptions, auditExportUrl } from "@/lib/audit/queries";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events.
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  component: AuditPage,
});

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
    search: "?eventType=computer.action_allowed",
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

function AuditPage() {
  const [search, setSearch] = useState<string>(FILTERS[0].search);
  const [query, setQuery] = useState("");
  const events = useQuery(auditEventsQueryOptions(search));
  const rows = (events.data?.events ?? []) as AuditEvent[];
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
        fallback: "Couldn't export audit events. Try again.",
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
          : "Couldn't export audit events. Try again.",
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    /*
     * THE ONE FULL-WIDTH PAGE IN ADMIN, and the one that keeps a table. The page is the window's
     * height; the title, the views and the search stay where they are and only the rows scroll,
     * because a log is scanned across and rows of prose would make every entry a paragraph.
     */
    <PageShell
      description="Review Bot actions and actions blocked by this deployment’s policy."
      title="Audit"
      width="full"
    >
      {events.isPending ? null : events.isError ? (
        <p className="px-4 text-destructive text-sm" role="alert">
          Couldn't load the audit log. Reload the page.
        </p>
      ) : (
        <AuditTable
          events={rows}
          nameFor={nameFor}
          query={query}
          toolbar={({ count, filters }) => (
            <div className="flex shrink-0 flex-col gap-3 border-border border-b px-4 pb-3">
              {/*
               * The saved views are one control with one answer, so they are drawn as a segmented
               * group: the pressed one is filled, the rest sit flat inside the same outline.
               */}
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">View</span>
                <fieldset
                  aria-label="View"
                  className="inline-flex items-center gap-0.5 rounded-lg border border-border p-0.5"
                >
                  {FILTERS.map((filter) => {
                    const active = search === filter.search;
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
                        onClick={() => setSearch(filter.search)}
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
                {filters}
                <span className="ml-1 text-muted-foreground text-xs tabular-nums">
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
                  events, not all of them. Narrow the filter or dates to export
                  the rest.
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
    </PageShell>
  );
}
