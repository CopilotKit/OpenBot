/**
 * A read that failed, with the way to try it again.
 *
 * A screen that draws several reads at once says which one failed and keeps what the others
 * loaded. It needs the failure as data to do that: which query, and how to ask it again. Reading
 * the message to work out the source would break the first time a server rewords it.
 *
 * TanStack Query keeps a query's last data when a refetch fails, so a failure here does not mean
 * the rows are gone. It means they may be out of date or incomplete.
 */
export type ReadFailure = {
  error: Error;
  retry: () => void;
  /** A retry is on its way, so the button can say so instead of being pressed twice. */
  retrying: boolean;
};

export function readFailure(query: {
  error: Error | null;
  isFetching: boolean;
  refetch: () => unknown;
}): ReadFailure | null {
  if (!query.error) return null;
  return {
    error: query.error,
    retry: () => void query.refetch(),
    retrying: query.isFetching,
  };
}
