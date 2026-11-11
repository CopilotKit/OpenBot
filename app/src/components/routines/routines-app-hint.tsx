import { Link } from "@tanstack/react-router";

/**
 * Beside Routines in a list of apps a Bot can use: what asking for one sounds like, and the way to
 * the Routines page. Without it, Routines reads as one more app next to Gmail, with no hint that it
 * means "do this on a schedule".
 */
export function RoutinesAppHint() {
  return (
    <span className="ml-auto flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
      <span className="truncate">e.g. “every weekday at 9, send me…”</span>
      <Link
        className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
        to="/routines"
      >
        Open Routines
      </Link>
    </span>
  );
}
