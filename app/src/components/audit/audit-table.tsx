import { IconArrowDown, IconArrowUp, IconSearch } from "@tabler/icons-react";
import {
  type ColumnDef,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { outcomeOf } from "@/lib/audit/outcome";
import { cn } from "@/lib/utils";
import {
  type AuditEvent,
  BotCell,
  DecisionCell,
  OnCell,
  OUTCOME_MARK,
  OUTCOME_ROW,
  StartedByCell,
  searchTextOf,
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

export function AuditTable({
  events,
  nameFor,
  query,
  toolbar,
}: {
  events: AuditEvent[];
  nameFor: NameFor;
  query: string;
  /** Drawn above the table, given how many rows it shows ("3 events", "1 of 3 events"). */
  toolbar: (count: string) => React.ReactNode;
}) {
  const [sorting, setSorting] = useState<SortingState>(INITIAL_SORT);
  const columns = useMemo(() => auditColumns(nameFor), [nameFor]);
  const table = useTable({
    features,
    columns,
    data: events,
    getRowId: (event) => event.id,
    state: { sorting, globalFilter: query },
    onSortingChange: setSorting,
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
      {toolbar(countLabel(rows.length, events.length))}
      <Table>
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
            Nothing loaded matches this search.
          </PageEmpty>
        </div>
      ) : null}
    </>
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
      cell: ({ row }) => <OnCell event={row.original} nameFor={nameFor} />,
      enableSorting: false,
    },
    {
      id: "bot",
      header: "Bot",
      cell: ({ row }) => <BotCell event={row.original} nameFor={nameFor} />,
      enableSorting: false,
    },
    {
      id: "startedBy",
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
