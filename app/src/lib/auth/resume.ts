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

/**
 * The route that resumes a flow. This deployment's own, on its own origin. OpenBot Desktop's window
 * opens it with no handle to finish the one its person's browser brought back
 * (`lib/plugins/finish-on-return.ts`).
 */
export const VERIFIER_PATH = "/api/plugins/arcade/verify";

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

/**
 * The phone app's sign-in hand-off, on this origin (docs/shell-sign-in.md on the server, "Returning
 * through /sign"). On a self-hosted OpenBot a signed-out sign-in sheet lands on `/sign` carrying
 * `shell_challenge`, `shell_platform` and `shell_callback`; once signed in, the sheet goes on to the
 * hand-off, which shows "Continue to the OpenBot app", rather than into the web app inside the sheet.
 */
export const SHELL_HANDOFF_PATH = "/api/auth/shell/handoff";

/** What `/sign` was handed for the sheet, as its search names it. */
export type ShellReturnSearch = {
  shell_challenge?: string;
  shell_platform?: string;
  shell_callback?: string;
};

/** A PKCE S256 challenge: 43 characters of base64url, nothing else. */
const SHELL_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The hand-off's path, built here from the 3 values once each checks out: the challenge exactly 43
 * base64url characters, the platform absent, `ios` or `android`, the callback absent or `https`.
 * Anything else and all 3 are ignored (null). Values, never an address: as with `flow_id`, nothing
 * taken from the query is ever a place to go.
 */
export function shellHandoffPathFor(search: ShellReturnSearch): string | null {
  const challenge = search.shell_challenge;
  const platform = search.shell_platform;
  const callback = search.shell_callback;
  if (typeof challenge !== "string" || !SHELL_CHALLENGE.test(challenge))
    return null;
  if (platform !== undefined && platform !== "ios" && platform !== "android")
    return null;
  if (callback !== undefined && callback !== "https") return null;
  return [
    `${SHELL_HANDOFF_PATH}?challenge=${challenge}`,
    platform ? `&platform=${platform}` : "",
    callback ? `&callback=${callback}` : "",
  ].join("");
}

/**
 * Where sign-in on `/sign` sends the browser back to: the phone app's hand-off when the sheet's
 * values check out (they win over `flow_id`: the sheet is the app's), else as `resumeUrlFor` says.
 */
export function signInReturnUrlFor(
  origin: string,
  search: ShellReturnSearch & { flow_id?: string },
): string {
  const handoff = shellHandoffPathFor(search);
  return handoff === null
    ? resumeUrlFor(origin, search.flow_id)
    : `${origin}${handoff}`;
}
