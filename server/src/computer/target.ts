/**
 * What a Bot's browser is allowed to navigate to.
 *
 * A computer-use browser is an SSRF engine pointed at your own network unless something stops it.
 * The Bot runs inside the deployment, so `http://localhost:5432`, the cloud metadata endpoint at
 * 169.254.169.254, and every RFC1918 address are all reachable from it and none of them are reachable
 * from the person's laptop. A model that has been talked into "check what is on 10.0.0.5" would
 * otherwise do exactly that and screenshot the result back into the transcript.
 *
 * This is an allow-list of schemes plus a deny-list of destinations, applied before the request is
 * made rather than after. It is deliberately dumb: no DNS resolution, no redirect following, no
 * cleverness that could disagree with what the browser eventually does. The gateway sits in front
 * of every action, which is where policy per Bot belongs; this is the floor that holds even without it.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Addresses no deployment may ever open, including one that opted into private hosts.
 *
 * Reading instance metadata is how a container's cloud credentials leave it, and there is no
 * development task that needs it, so it is not covered by the private-host escape hatch.
 */
const NEVER_ALLOWED_HOSTNAMES = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
]);

/** Hostnames inside the deployment. Reachable only when a deployment opts in. */
const INTERNAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

export type TargetVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, includes metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Decide whether an address a supervisor handed back may be called at all.
 *
 * Deliberately not {@link checkNavigationTarget}. That one judges where a Bot may browse, and its
 * private-host rule is exactly wrong here: our own supervisor answers with `http://127.0.0.1:<port>`
 * for a container on this machine, so applying it would refuse the normal case.
 *
 * What survives is what holds however the address was produced. The scheme must be one we speak, and
 * the cloud metadata addresses are refused whatever anything says, because that is how a container's
 * credentials leave it and no supervisor has a reason to name one.
 *
 * This matters because the address stops being ours. With a hosted provider (A10) it arrives from a
 * third party's API and goes straight into `fetch` carrying this deployment's computer token, so it
 * is worth one check that it is an address rather than a surprise.
 */
export function checkComputerAddress(raw: string): TargetVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      allowed: false,
      reason: `The computer's address is not a URL: ${raw}`,
    };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      allowed: false,
      reason: `A computer must be reached over http or https, not ${url.protocol.replace(":", "")}.`,
    };
  }

  if (NEVER_ALLOWED_HOSTNAMES.has(url.hostname.toLowerCase())) {
    return {
      allowed: false,
      reason:
        "That address holds this deployment's own cloud credentials, so it is never called as a computer.",
    };
  }

  return { allowed: true, url: url.toString() };
}

/**
 * Decide whether a Bot may navigate here.
 *
 * Returns a reason rather than throwing, because the caller renders it to a person: "that address is
 * inside the deployment" is actionable, and a stack trace is not.
 */
export function checkNavigationTarget(
  raw: string,
  options: { allowPrivateHosts?: boolean } = {},
): TargetVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "That is not a web address." };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      allowed: false,
      reason: `Only web addresses are allowed, and that one is ${url.protocol.replace(":", "")}.`,
    };
  }

  const hostname = url.hostname.toLowerCase();

  // Checked before the opt-in, so no configuration can reach it.
  if (NEVER_ALLOWED_HOSTNAMES.has(hostname)) {
    return {
      allowed: false,
      reason:
        "That address holds this deployment's own cloud credentials, so the assistant is never allowed to open it.",
    };
  }

  // A local deployment legitimately browses its own services. It is opt-in, never the default, so a
  // production deployment cannot reach its own network by forgetting to set something.
  if (options.allowPrivateHosts) {
    return { allowed: true, url: url.toString() };
  }

  if (INTERNAL_HOSTNAMES.has(hostname) || isPrivateIpv4(hostname)) {
    return {
      allowed: false,
      reason:
        "That address is inside this deployment's own network, so the assistant is not allowed to open it.",
    };
  }

  return { allowed: true, url: url.toString() };
}
