import {
  IconArrowDown,
  IconArrowUp,
  IconCirclePlus,
  IconSearch,
} from "@tabler/icons-react";
import {
  type ColumnDef,
  type ColumnFiltersState,
  columnFilteringFeature,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import type * as React from "react";
import { useMemo, useState } from "react";
import { PageEmpty } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type AuditOutcome, outcomeOf } from "@/lib/audit/outcome";
import { cn } from "@/lib/utils";
import {
  type AuditEvent,
  BotCell,
  botText,
  DecisionCell,
  OnCell,
  OUTCOME_MARK,
  OUTCOME_ROW,
  StartedByCell,
  searchTextOf,
  startedByText,
  whatText,
  whenText,
} from "./audit-cells";

/**
 * The audit log as a table: newest first, sortable by time, searchable across everything a row
 * shows. Sorting and search act on the events already loaded; the saved views above it are what
 * ask the server for a different set.
 */
const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
});

type NameFor = (botId: string) => string;

/** Only the hidden `search` column takes part in search; it holds every visible word of the row. */
const SEARCHABLE = new Set(["search"]);

const INITIAL_SORT: SortingState = [{ id: "when", desc: true }];

const OUTCOME_LABEL: Record<AuditOutcome, string> = {
  allowed: "Allowed",
  refused: "Blocked",
  "did-not-happen": "Did not happen",
};

/**
 * The columns a toolbar button narrows by, each matching any of the values ticked. Like search, they
 * act on the rows already loaded.
 */
const FACETS = [
  { id: "mark", title: "Outcome" },
  { id: "bot", title: "Bot" },
  { id: "startedBy", title: "Started by" },
] as const;

export function AuditTable({
  events,
  nameFor,
  query,
  toolbar,
}: {
  events: AuditEvent[];
  nameFor: NameFor;
  query: string;
  /**
   * Drawn above the table, given how many rows it shows ("3 events", "1 of 3 events") and the filter
   * buttons to place beside the search. It stays put; only the rows under it scroll.
   */
  toolbar: (parts: {
    count: string;
    filters: React.ReactNode;
  }) => React.ReactNode;
}) {
  const [sorting, setSorting] = useState<SortingState>(INITIAL_SORT);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const columns = useMemo(() => auditColumns(nameFor), [nameFor]);
  const table = useTable({
    features,
    columns,
    data: events,
    getRowId: (event) => event.id,
    state: { sorting, globalFilter: query, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    enableSortingRemoval: false,
    globalFilterFn: (row, _columnId, value: string) =>
      row
        .getValue<string>("search")
        .includes(String(value).trim().toLowerCase()),
    getColumnCanGlobalFilter: (column) => SEARCHABLE.has(column.id),
  });
  const rows = table.getRowModel().rows;

  return (
    <>
      {toolbar({
        count: countLabel(rows.length, events.length),
        filters: FACETS.map((facet) => {
          const column = table.getColumn(facet.id);
          const selected = (column?.getFilterValue() as string[]) ?? [];
          return (
            <Facet
              key={facet.id}
              onChange={(next) =>
                column?.setFilterValue(next.length > 0 ? next : undefined)
              }
              options={tally(events, (event) =>
                String(column?.accessorFn?.(event, 0) ?? ""),
              )}
              selected={selected}
              title={facet.title}
            />
          );
        }),
      })}
      <Table
        containerClassName={rows.length > 0 ? "min-h-0 flex-1" : undefined}
      >
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow className="hover:bg-transparent" key={group.id}>
              {group.headers
                .filter((header) => header.column.id !== "search")
                .map((header) => (
                  <TableHead
                    className={cn(
                      header.column.id === "mark" && "w-8 pr-0 pl-4",
                    )}
                    key={header.id}
                  >
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const outcome = outcomeOf(row.original.eventType);
            return (
              <TableRow
                className={OUTCOME_ROW[outcome]}
                data-outcome={outcome}
                key={row.id}
              >
                {row
                  .getAllCells()
                  .filter((cell) => cell.column.id !== "search")
                  .map((cell) => (
                    <TableCell
                      className={cn(
                        cell.column.id === "mark" && "w-8 pr-0 pl-4",
                        cell.column.id === "when" &&
                          "whitespace-nowrap font-mono text-muted-foreground text-xs tabular-nums",
                        cell.column.id === "what" && "font-medium",
                        cell.column.id === "bot" && "whitespace-nowrap",
                      )}
                      data-column={cell.column.id}
                      key={cell.id}
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {events.length > 0 && rows.length === 0 ? (
        <div className="px-4">
          <PageEmpty icon={IconSearch} title="No matches">
            Nothing loaded matches this search and these filters.
          </PageEmpty>
        </div>
      ) : null}
    </>
  );
}

/** A row passes when its value is one of those ticked. */
function anyOf(
  row: { getValue: <T>(id: string) => T },
  columnId: string,
  value: string[],
): boolean {
  return value.includes(row.getValue<string>(columnId));
}

/** Each value a column holds across the loaded events, with how many rows have it, most first. */
function tally(
  events: AuditEvent[],
  valueFor: (event: AuditEvent) => string,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    const value = valueFor(event);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** A dashed button that opens a list of a column's values to tick, as in a data table's toolbar. */
function Facet({
  title,
  options,
  selected,
  onChange,
}: {
  title: string;
  options: { value: string; count: number }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button className="border-dashed" size="sm" variant="outline" />
        }
      >
        <IconCirclePlus />
        {title}
        {selected.length > 0 ? (
          <span className="ml-1 rounded-sm bg-muted px-1 font-normal text-xs">
            {selected.length === 1
              ? selected[0]
              : `${selected.length} selected`}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-52">
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            checked={selected.includes(option.value)}
            key={option.value}
            onCheckedChange={(next) =>
              onChange(
                next
                  ? [...selected, option.value]
                  : selected.filter((value) => value !== option.value),
              )
            }
          >
            <span className="truncate">{option.value}</span>
            <span className="ml-auto text-muted-foreground text-xs tabular-nums">
              {option.count}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        {selected.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange([])}>
              Clear filter
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How many rows the table is showing, for the toolbar. */
function countLabel(shown: number, total: number): string {
  const noun = total === 1 ? "event" : "events";
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

function auditColumns(
  nameFor: NameFor,
): ColumnDef<typeof features, AuditEvent>[] {
  return [
    {
      id: "mark",
      accessorFn: (event) => OUTCOME_LABEL[outcomeOf(event.eventType)],
      filterFn: anyOf,
      header: () => <span className="sr-only">Outcome</span>,
      cell: ({ row }) => (
        <span
          aria-hidden
          className={cn(
            "mt-1 block size-2.5 rounded-[3px]",
            OUTCOME_MARK[outcomeOf(row.original.eventType)],
          )}
        />
      ),
      enableSorting: false,
    },
    {
      id: "when",
      accessorFn: (event) => Date.parse(event.createdAt),
      header: ({ column }) => {
        const sorted = column.getIsSorted();
        return (
          <button
            className="-mx-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
            onClick={column.getToggleSortingHandler()}
            type="button"
          >
            When
            {sorted === "asc" ? (
              <IconArrowUp className="size-3.5" />
            ) : (
              <IconArrowDown className="size-3.5" />
            )}
            <span className="sr-only">
              {sorted === "asc" ? ", oldest first" : ", newest first"}
            </span>
          </button>
        );
      },
      cell: ({ row }) => whenText(row.original),
      sortFn: (a, b, id) => a.getValue<number>(id) - b.getValue<number>(id),
    },
    {
      id: "what",
      accessorFn: (event) => whatText(event),
      header: "What",
      cell: ({ row }) => whatText(row.original),
      enableSorting: false,
    },
    {
      id: "on",
      header: "On",
      cell: ({ row }) => <OnCell event={row.original} />,
      enableSorting: false,
    },
    {
      id: "bot",
      accessorFn: (event) => botText(event, nameFor) || "None",
      filterFn: anyOf,
      header: "Bot",
      cell: ({ row }) => <BotCell event={row.original} nameFor={nameFor} />,
      enableSorting: false,
    },
    {
      id: "startedBy",
      accessorFn: (event) => startedByText(event, nameFor),
      filterFn: anyOf,
      header: "Started by",
      cell: ({ row }) => (
        <StartedByCell event={row.original} nameFor={nameFor} />
      ),
      enableSorting: false,
    },
    {
      id: "decision",
      header: "Decision",
      cell: ({ row }) => <DecisionCell event={row.original} />,
      enableSorting: false,
    },
    {
      id: "search",
      accessorFn: (event) => searchTextOf(event, nameFor),
      header: () => null,
      cell: () => null,
      enableSorting: false,
    },
  ];
}
