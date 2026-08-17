/**
 * Visible component refusal, using the same blocked-action semantics as computer policy refusals.
 */
export function RefusedCard({
  title,
  reason,
}: {
  /** The component's own title where we know it, so a person is not shown a tool name. */
  title: string;
  reason: string;
}) {
  return (
    <div
      className="my-2 w-full max-w-2xl rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid="component-refused"
      role="status"
    >
      <p className="text-sm font-medium text-destructive">Not shown: {title}</p>
      <p className="mt-1 text-sm text-foreground/80">{reason}</p>
    </div>
  );
}
