/**
 * The pulsing dot Activity rows put on a row that is running now, on the corner of its icon. The
 * icon's `ItemMedia` is made `relative` to hold it.
 */
export function RunningDot() {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-emerald-500 ring-2 ring-card"
      data-running
    />
  );
}
