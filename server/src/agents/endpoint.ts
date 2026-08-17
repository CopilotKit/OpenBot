import { checkNavigationTarget } from "../computer/target";

/**
 * Where an external agent lives, and whether we are willing to talk to it.
 *
 * Registering an agent hands us a URL that this server will POST to on every single run. That is a
 * server-side request to an address a user chose,
 * which is the textbook shape of SSRF: without a check, `http://169.254.169.254/` is a registrable
 * "agent" and the runtime will happily fetch cloud credentials on a user's behalf, from inside the
 * deployment, on a schedule.
 *
 * Ordering is the control. If the private-host escape hatch is consulted before the
 * deny-list, the cloud metadata endpoint is reachable under the configuration every developer
 * actually runs. Never-allowed hosts are refused first, ahead of any opt-in, which is why this reuses
 * `checkNavigationTarget` rather than a second checker that would have to get the ordering right
 * again.
 *
 * A developer's own agent legitimately lives at
 * `http://localhost:4200/ag-ui`, so on a laptop the private-host opt-in is ON, which is the case where
 * this check is weakest. That is the same trade navigation makes, and the reason the never-allowed
 * list is checked ahead of it. In a hosted deployment the opt-in is off and a private address is
 * refused.
 */

export type EndpointVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

/**
 * Check an agent endpoint before it is stored.
 *
 * Refused at registration rather than at run time: a URL that must never be fetched should
 * never reach the database, because everything downstream treats a stored agent as trustworthy.
 */
export function checkAgentEndpoint(
  raw: unknown,
  options: { allowPrivateHosts?: boolean } = {},
): EndpointVerdict {
  if (typeof raw !== "string" || !raw.trim()) {
    return { allowed: false, reason: "An agent needs a web address." };
  }

  const verdict = checkNavigationTarget(raw.trim(), options);
  if (!verdict.allowed) {
    // The navigation wording talks about "the assistant opening" a page, which is not what is
    // happening here, so the reason is restated for the form surface.
    return {
      allowed: false,
      reason: verdict.reason.replace(
        /the assistant is never allowed to open it\.|the assistant is not allowed to open it\./,
        "an agent may not live there.",
      ),
    };
  }

  return { allowed: true, url: verdict.url };
}
