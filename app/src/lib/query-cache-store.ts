import { notifyManager, type QueryClient } from "@tanstack/react-query";

/**
 * A query cache as a `useSyncExternalStore` source: `changed` is called after each change to it, in
 * the next batch of Query's own notifications, never in the middle of a render.
 *
 * THE CACHE TELLS ITS SUBSCRIBERS AT ONCE, AND A RENDER CAN BE WHAT TOLD IT. A component reading a
 * query with `useQuery` makes its observer as it first renders, and the observer reports its first
 * result to the cache there and then. Subscribed directly, a store that had changed since its own
 * component last drew was asked to draw again from inside that other component's render, which is
 * React's "Cannot update a component while rendering a different component": the transcript, while
 * an approval card for a step that had just arrived drew itself. `useQuery`'s own subscription is
 * batched the same way (`notifyManager.batchCalls`), which is what keeps it out of renders.
 */
export function subscribeToQueryCache(
  client: QueryClient,
  changed: () => void,
): () => void {
  return client.getQueryCache().subscribe(notifyManager.batchCalls(changed));
}
