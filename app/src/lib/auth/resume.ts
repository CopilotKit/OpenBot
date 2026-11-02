/**
 * Where somebody goes once they are signed in, when they were sent to sign-in carrying a handle.
 *
 * This is the return half of the decision `signInUrlFor` makes on the way out (server/src/plugins/
 * routes.ts): the verifier sends a browser with no session here carrying its `flow_id`, and this is
 * what lets signing back in as the same person pick that flow up where it was left.
 *
 * THE HANDLE IS A VALUE, NEVER A DESTINATION. `flow_id` arrives in a URL and is therefore somebody
 * else's input. It is encoded into a path this code builds, on an origin this code was given. It is
 * never used as a redirect target, never concatenated into one, and there is no `next=`: a return
 * address somebody else gets a say in is an open redirect, and a handle that can only ever be a
 * query value on this deployment's own verifier cannot be pointed anywhere else.
 */

/** The route that resumes a flow. This deployment's own, on its own origin. */
const VERIFIER_PATH = "/api/plugins/arcade/verify";

/**
 * Longer than any handle the server issues, short enough that a crafted link cannot make the
 * callback URL arbitrarily large. Over the cap the value is not truncated: a truncated handle is a
 * different handle, so it is treated as no handle at all.
 */
const MAX_FLOW_ID_LENGTH = 256;

function usable(flowId: string | undefined): flowId is string {
  return (
    typeof flowId === "string" &&
    flowId.length > 0 &&
    flowId.length <= MAX_FLOW_ID_LENGTH
  );
}

/** The verifier's path with the handle as a query value, or null when there is no usable handle. */
export function verifierPathFor(flowId: string | undefined): string | null {
  return usable(flowId)
    ? `${VERIFIER_PATH}?flow_id=${encodeURIComponent(flowId)}`
    : null;
}

/**
 * Where sign-in should send the browser back to: the verifier carrying the handle, or the origin
 * itself when there is none. Pure, so the resume is pinned without a DOM, a router or Better Auth.
 */
export function resumeUrlFor(
  origin: string,
  flowId: string | undefined,
): string {
  const path = verifierPathFor(flowId);
  return path === null ? origin : `${origin}${path}`;
}
