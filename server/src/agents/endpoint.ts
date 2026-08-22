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

/**
 * How many redirects an agent is allowedbefore we stop believing it has somewhere to be.
 *
 * Three, which covers the ordinary shapes (`http` to `https`, a host rename, a trailing-slash
 * canonicalisation) and stops a chain that has no end.
 */
const MAX_REDIRECTS = 3;

/** An address this deployment will not dial, named so the person registering sees which hop. */
export class EndpointNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointNotAllowedError";
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The headers an AG-UI POST needs to be an AG-UI POST. Everything else on one of these requests is
 * the registered agent's own configuration, which is to say its key.
 */
const PROTOCOL_HEADERS = new Set(["content-type", "accept"]);

/**
 * Whether a hop stays inside the authorisation the request was carrying credentials for.
 *
 * Host and port must match, because a different one is a different party however similar the name.
 * A scheme upgrade is the exception in the permissive direction: `http` to `https` on the same host
 * is the ordinary shape of a deployment behind a redirect, and the credential ends up somewhere
 * strictly better protected than where it started. The downgrade is not the same trade and is
 * treated as a different party.
 */
function sameCredentialScope(from: string, to: string): boolean {
  const a = new URL(from);
  const b = new URL(to);
  if (a.hostname !== b.hostname || a.port !== b.port) return false;
  return (
    a.protocol === b.protocol ||
    (a.protocol === "http:" && b.protocol === "https:")
  );
}

/** The request with everything that proves who we are taken out of it. */
function withoutCredentials(init: RequestInit | undefined): RequestInit {
  const kept = new Headers();
  for (const [name, value] of new Headers(init?.headers)) {
    if (PROTOCOL_HEADERS.has(name.toLowerCase())) kept.set(name, value);
  }
  return { ...init, headers: kept, ...strippedBody(init?.body) };
}

/**
 * The body with this deployment's own signed run taken out of it.
 *
 * The run assertion is a bearer capability: it names the Bot and the person, and whatever holds it
 * can call back and spend that person's grants. Stripping the headers and forwarding the body would
 * leave the more valuable of the two credentials travelling.
 *
 * A body this cannot read is not forwarded at all. A stream or a form is not a shape this deployment
 * sends here, so the choice is between refusing an unreachable case and forwarding something
 * unexamined to a host the request was not authorised for, and only one of those fails safely.
 */
function strippedBody(body: BodyInit | null | undefined): { body?: BodyInit } {
  if (body === null || body === undefined) return {};
  if (typeof body !== "string") {
    throw new EndpointNotAllowedError(
      "That address redirected to another host, and this deployment will not forward the run to it.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not ours to sanitise and not ours to leak. The same reasoning as the non-string case.
    throw new EndpointNotAllowedError(
      "That address redirected to another host, and this deployment will not forward the run to it.",
    );
  }
  if (parsed === null || typeof parsed !== "object") return { body };

  const run = parsed as { forwardedProps?: Record<string, unknown> };
  if (!run.forwardedProps || typeof run.forwardedProps !== "object") {
    return { body };
  }
  const { openbotRun: _dropped, ...rest } = run.forwardedProps;
  return { body: JSON.stringify({ ...run, forwardedProps: rest }) };
}

/**
 * `fetch`, with the endpoint check applied to every hop rather than only the address a person typed.
 *
 * Checking the URL once and then handing it to a fetch that follows redirects is a check with a hole
 * in it: `https://agent.example.com/ag-ui` passes, answers `307`, and the request lands wherever the
 * `Location` header says, which is how a registrable agent becomes a way to read the deployment's own
 * cloud metadata. The address that gets dialled is the one that must be allowed, and a redirect makes
 * those two different addresses.
 *
 * The stored address is checked too, not only the hops after it. A row written before this guard
 * existed, or under a rule that has since changed, is dialled on every run, and that is the one
 * address a check that only reads `Location` headers never looks at.
 *
 * Redirects are followed rather than refused, because a deployment that puts its agent behind one has
 * done nothing wrong and `http` to `https` is the common case. Each destination goes through
 * {@link checkAgentEndpoint} first, so following one can only ever reach somewhere registering it
 * directly would have been allowed to reach.
 *
 * A hop that leaves the host the request was authorised for arrives with nothing that proves who we
 * are: the customer's key is theirs and was given to us for their host, and the run assertion is
 * this deployment's own capability. Once dropped they stay dropped, so a chain that wanders off and
 * comes back does not collect them again.
 *
 * The method and body are carried across every hop. A browser turns a redirected `POST` into a `GET`;
 * doing that here would only ever produce a confusing "that is not an AG-UI endpoint" from an agent
 * that is one, because AG-UI is a POST protocol and this is a server talking to an API, not a person
 * following a link.
 */
export function createAgentFetch(
  options: { allowPrivateHosts?: boolean; fetchImpl?: typeof fetch } = {},
): (url: string, init?: RequestInit) => Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const check = (address: string) =>
    checkAgentEndpoint(address, {
      ...(options.allowPrivateHosts !== undefined
        ? { allowPrivateHosts: options.allowPrivateHosts }
        : {}),
    });

  return async function guardedFetch(url: string, init?: RequestInit) {
    const stored = check(url);
    if (!stored.allowed) {
      throw new EndpointNotAllowedError(
        `This deployment will not dial ${url}: ${stored.reason.charAt(0).toLowerCase()}${stored.reason.slice(1)}`,
      );
    }

    const origin = stored.url;
    let target = stored.url;
    let carried = init;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // `manual` is what makes this a check rather than a comment: the caller sees the redirect, and
      // the underlying fetch cannot quietly follow one on its own.
      const response = await doFetch(target, {
        ...carried,
        redirect: "manual",
      });
      if (!REDIRECT_STATUSES.has(response.status)) return response;

      const location = response.headers.get("location");
      // A redirect status with nowhere to go is just an answer. Whatever it means, it is the
      // agent's own reply and not a hop.
      if (!location) return response;

      const next = new URL(location, target).toString();
      const verdict = check(next);
      if (!verdict.allowed) {
        throw new EndpointNotAllowedError(
          `That address redirected to ${next}, and ${verdict.reason.charAt(0).toLowerCase()}${verdict.reason.slice(1)}`,
        );
      }
      if (!sameCredentialScope(origin, verdict.url)) {
        carried = withoutCredentials(carried);
      }
      target = verdict.url;
    }

    throw new EndpointNotAllowedError(
      `That address redirected more than ${MAX_REDIRECTS} times without arriving anywhere.`,
    );
  };
}
