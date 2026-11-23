import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A data table's parts, for a log or report read across the full pane.
 *
 * The container is the card (theme.css `--color-table`, `--radius-table`: Figma's white card in the
 * current kit, none in the legacy kit) and the scroller: given a height (`containerClassName`), the
 * rows scroll under a header that stays put; without one, a table wider than the pane scrolls sideways.
 */
function Table({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <div
      data-slot="table-container"
      className={cn(
        "relative w-full overflow-auto rounded-table bg-table",
        containerClassName,
      )}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      /*
       * Pinned to the top of the container. The line under it is a shadow, not a border: a collapsed
       * table border belongs to the rows and scrolls away with them.
       */
      className={cn(
        "sticky top-0 z-10 bg-table-head-bg shadow-[inset_0_-1px_0_var(--color-border)] [&_tr]:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-border border-b transition-colors hover:bg-muted/50",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      /*
       * The UI Kit's "Table header": the column's name in 12px regular gray, in tokens (theme.css)
       * that the skins set back to 14px medium (skins/legacy-base.css).
       */
      className={cn(
        "h-table-head whitespace-nowrap px-table-cell-x text-left align-middle text-table-head-size font-(--table-head-weight) text-table-head",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-table-cell-x py-table-cell-y align-top", className)}
      {...props}
    />
  );
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
