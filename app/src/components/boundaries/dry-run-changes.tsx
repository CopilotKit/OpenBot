import type { DryRunChange } from "@/lib/computers/queries";

/**
 * Actions already on the trail that a rule decides differently, one line each.
 *
 * `total` is the count over everything scanned. The list is capped by the server, and a reader who
 * stops at the rows should not believe the rows are the whole answer, so the gap is said under them.
 */
export function DryRunChanges({
  changes,
  total,
}: {
  changes: DryRunChange[];
  total: number;
}) {
  if (changes.length === 0) return null;
  return (
    <>
      <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
        {changes.map((change) => (
          <li className="px-3 py-2" key={change.id}>
            <p className="text-xs">
              <code className="font-mono">{change.action}</code>
              {change.element?.name ? <> on “{change.element.name}”</> : null}
              {change.command ? (
                <>
                  {" "}
                  running <code className="font-mono">{change.command}</code>
                </>
              ) : null}
              {change.file ? <> touching {change.file}</> : null}
            </p>
            <p className="mt-0.5 text-muted-foreground text-xs">
              {change.bot}
              {change.page ? <> · {change.page}</> : null} ·{" "}
              {new Date(change.createdAt).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>
      {total > changes.length ? (
        <p className="mt-1 text-muted-foreground text-xs">
          Showing the first {changes.length} of {total}.
        </p>
      ) : null}
    </>
  );
}
