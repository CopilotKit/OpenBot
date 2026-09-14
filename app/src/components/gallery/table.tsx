import { useState } from "react";
import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame } from "./frame";

export const DataTableProps = z
  .object({
    title: z.string().trim().min(1).max(120),
    caption: z.string().max(500).optional(),
    columns: z
      .array(z.string().trim().min(1).max(80))
      .min(1)
      .max(8)
      .describe("Unique column labels, in display order"),
    rows: z
      .array(
        z.object({
          cells: z
            .array(z.union([z.string().max(2000), z.number()]))
            .min(1)
            .max(8),
        }),
      )
      .max(100)
      .describe(
        "One cell per column. Use numbers for numeric sorting; strings for formatted values.",
      ),
  })
  .refine(
    (table) =>
      new Set(table.columns).size === table.columns.length &&
      table.rows.every((row) => row.cells.length === table.columns.length),
    "Column labels must be unique and every row must have one cell per column",
  );

/** A real table: header buttons sort while the native row/column relationships stay intact. */
export function DataTable(props: Record<string, unknown>) {
  const [sort, setSort] = useState<{
    column: number;
    ascending: boolean;
  } | null>(null);
  const parsed = DataTableProps.safeParse(props);
  if (!parsed.success) {
    return (
      <GalleryFrame title="Table">
        <p className="text-sm text-muted-foreground">
          Waiting for complete table data…
        </p>
      </GalleryFrame>
    );
  }
  const { title, caption, columns, rows } = parsed.data;
  const ordered = rows.map((row, position) => ({ ...row, position }));
  if (sort) {
    ordered.sort((left, right) => {
      const a = left.cells[sort.column];
      const b = right.cells[sort.column];
      const order =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { numeric: true });
      return (
        (sort.ascending ? order : -order) || left.position - right.position
      );
    });
  }
  return (
    <GalleryFrame
      title={title}
      caption={caption}
      action={
        <Badge>
          {rows.length} {rows.length === 1 ? "row" : "rows"}
        </Badge>
      }
    >
      <section
        className="overflow-x-auto rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`${title} table, scroll for more columns`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Overflow regions need keyboard focus to scroll in Safari; the region has an accessible name.
        tabIndex={0}
      >
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">
            {title}. Select a column heading to sort.
          </caption>
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              {columns.map((column, index) => (
                <th
                  key={column}
                  scope="col"
                  aria-sort={
                    sort?.column === index
                      ? sort.ascending
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  className="border-b border-border font-medium"
                >
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 whitespace-nowrap px-3 py-2.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    onClick={() =>
                      setSort({
                        column: index,
                        ascending:
                          sort?.column === index ? !sort.ascending : true,
                      })
                    }
                  >
                    {column}
                    <span
                      aria-hidden="true"
                      className="text-muted-foreground/70"
                    >
                      {sort?.column === index
                        ? sort.ascending
                          ? "↑"
                          : "↓"
                        : "↕"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ordered.map((row) => (
              <tr
                key={row.position}
                className="even:bg-muted/20 hover:bg-muted/40"
              >
                {columns.map((column, index) => (
                  <td
                    key={column}
                    className={`min-w-24 max-w-xs break-words px-3 py-2.5 align-top ${typeof row.cells[index] === "number" ? "text-right tabular-nums" : ""}`}
                  >
                    {row.cells[index] === "" ? (
                      <>
                        <span
                          className="text-muted-foreground"
                          aria-hidden="true"
                        >
                          —
                        </span>
                        <span className="sr-only">Empty</span>
                      </>
                    ) : (
                      row.cells[index]
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No rows to show.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      {rows.length > 1 && (
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          {sort
            ? `Sorted by ${columns[sort.column]}, ${sort.ascending ? "ascending" : "descending"}.`
            : "Select a column heading to sort."}
        </p>
      )}
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: "showTable",
    title: "Data table",
    kind: "card",
    description:
      "Show a sortable table to compare records, plans, or other structured facts. Supply up to eight columns and 100 rows, with exactly one cell per column. Use numbers for quantities so sorting is numeric. Show only data you have; do not invent rows.",
    parameters: DataTableProps,
    Component: DataTable,
    confirmation: "The sortable table is now on screen for the person.",
    preview: {
      title: "Team capacity",
      caption: "Three teams, one shared launch. Hours available this week.",
      columns: ["Team", "Available hours", "Focus"],
      rows: [
        { cells: ["Product", 24, "Customer onboarding"] },
        { cells: ["Engineering", 72, "Release readiness"] },
        { cells: ["Design", 18, "Workspace polish"] },
      ],
    },
  },
];
