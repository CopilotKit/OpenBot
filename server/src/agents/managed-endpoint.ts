/**
 * Which addresses this deployment runs itself, and therefore holds the token for.
 *
 * Two places need this answer and they must not disagree. The run path attaches the deployment
 * token to an agent registered at one of these addresses; the connection test has to knock the same
 * way, or it reports a refusal for a Bot that is about to work. They drifted once already — the
 * test button answered 401 for the Bot in the box — so the comparison lives here rather than being
 * written out twice.
 */

/** Keep the existing pathname slash tolerance without erasing query or fragment differences. */
export function managedEndpointIdentity(
  value: string | URL,
): string | undefined {
  try {
    const endpoint = new URL(value);
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
    return endpoint.toString();
  } catch {
    // An invalid stored URL is not a managed endpoint; it must not abort another agent's load.
    return undefined;
  }
}

/**
 * Whether `candidate` is one of the addresses this deployment runs.
 *
 * Every such address, not just the first. Matching a single endpoint left the harness picked during
 * setup without the token: registered, addressable, routed to, and answering `401 unauthorised` to
 * everything. Its container is this deployment's own, started on a port this deployment chose with
 * this token in its environment, so it is the same relationship the Bot in the box has.
 *
 * An address that cannot be parsed is nobody's, and in particular is not ours: an unreadable
 * candidate must never collide with an unreadable managed endpoint and be handed the token.
 */
export function isManagedEndpoint(
  candidate: string | URL,
  endpoints: readonly (string | URL | undefined)[],
): boolean {
  const identity = managedEndpointIdentity(candidate);
  if (identity === undefined) return false;
  return endpoints.some(
    (endpoint) =>
      endpoint !== undefined && identity === managedEndpointIdentity(endpoint),
  );
}
