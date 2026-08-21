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
  // The same endpoint over IPv6. A container with an IPv6 stack reaches its credentials here and
  // nowhere in the quad-form list above says so.
  "fd00:ec2::254",
  /*
   * The ECS and Fargate task-role endpoint. Not the instance metadata address above, and on Fargate
   * it is the only one there is: a task's IAM credentials are served from it, which is exactly what
   * this list exists to keep a Bot away from, and docs/deployment.md documents Fargate as a target.
   */
  "169.254.170.2",
  // Alibaba Cloud's equivalent, which also sits outside the usual link-local handling because
  // 100.64.0.0/10 is carrier-grade NAT rather than private space.
  "100.100.100.200",
]);

/** Hostnames inside the deployment. Reachable only when a deployment opts in. */
const INTERNAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
]);

export type TargetVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

/**
 * The hostname reduced to the one form the lists below are written in.
 *
 * A URL can carry the same destination several ways and the browser resolves all of them:
 * `metadata.google.internal.` with the root dot, and any of the IPv6 spellings that carry an IPv4
 * address in their last 32 bits. Matching the string a caller happened to type means a deny list with
 * a door in it, so every form is reduced here before anything is compared.
 *
 * `new URL()` has already done the parts of this that are its business: it lower-cases the host,
 * compresses IPv6, and turns `127.1` into `127.0.0.1`. What it does not do is unwrap an embedded IPv4
 * or drop the root dot, because both are legal and it is not the one deciding anything.
 */
function canonicalHostname(hostname: string): string {
  // The root dot. `example.com.` and `example.com` are the same name to DNS and to Chromium.
  const name = hostname.replace(/\.+$/, "");

  if (!name.startsWith("[") || !name.endsWith("]")) return name;
  const inner = name.slice(1, -1);

  const groups = expandIpv6(inner);
  if (!groups) return inner;
  return embeddedIpv4(groups) ?? inner;
}

/**
 * The IPv4 address an IPv6 one is carrying, if it is carrying one.
 *
 * Three prefixes put a whole IPv4 address in the low 32 bits and all three reach it: `::ffff:0:0/96`
 * is what a dual-stack socket uses, `64:ff9b::/96` is the well-known NAT64 prefix and translates on
 * any IPv6-only network with a gateway, and `::/96` is the deprecated compatible form. Whichever way
 * it was written, the destination is the IPv4 address, so that is what the rules should see.
 *
 * `::` and `::1` also have zeros in the top 96 bits and are NOT this: their low bits are 0.0.0.0 and
 * 0.0.0.1, which are not addresses anybody routes to. Anything in 0.0.0.0/8 is therefore left alone
 * and handled as the IPv6 address it is.
 */
function embeddedIpv4(groups: number[]): string | null {
  const [a, b, c, d, e, f, high = 0, low = 0] = groups;
  const zeros = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  const mapped = zeros && f === 0xffff;
  const compatible = zeros && f === 0;
  const nat64 =
    a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;

  if (!mapped && !compatible && !nat64) return null;
  /*
   * Only the compatible form keeps its 0.0.0.0/8 addresses as IPv6. `::` and `::1` live there and are
   * what `isPrivateIpv6` below recognises.
   *
   * The mapped and NAT64 forms are different: `[::ffff:0.0.0.0]` is what a dual-stack socket calls
   * 0.0.0.0, and 0.0.0.0 reaches every port bound on this host. Left wrapped it matched neither the
   * internal hostname list, which holds the bare quad form, nor `isPrivateIpv6`, which sees `ffff` in
   * the sixth group and moves on. Verified before the change: `[::ffff:0.0.0.0]:5432` was allowed
   * with the private-host opt-in off.
   */
  if (compatible && high >> 8 === 0) return null;

  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/**
 * The IPv6 ranges that are this deployment rather than the internet.
 *
 * Loopback, link-local (`fe80::/10`) and unique-local (`fc00::/7`, which is where cloud providers put
 * internal endpoints) are the IPv6 answers to the RFC1918 list above. The unspecified address is here
 * too: `[::]` reaches localhost the same way `0.0.0.0` does.
 */
function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const groups = expandIpv6(hostname);
  if (!groups) return false;

  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true; // ::1
  }

  const [first] = groups as [number, ...number[]];
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7
  return false;
}

/** The eight groups of an IPv6 address, or null if it is not one. Compression is expanded. */
function expandIpv6(hostname: string): number[] | null {
  const halves = hostname.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string) =>
    part === ""
      ? []
      : part.split(":").map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if ([...head, ...tail].some((group) => Number.isNaN(group))) return null;

  const missing = 8 - head.length - tail.length;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

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

  // Canonicalised for the same reason navigation is: the address reaches a fetch either way, so the
  // spellings that gate has to see through are the spellings this one has to see through.
  if (
    NEVER_ALLOWED_HOSTNAMES.has(canonicalHostname(url.hostname.toLowerCase()))
  ) {
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

  const hostname = canonicalHostname(url.hostname.toLowerCase());

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

  if (
    INTERNAL_HOSTNAMES.has(hostname) ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    return {
      allowed: false,
      reason:
        "That address is inside this deployment's own network, so the assistant is not allowed to open it.",
    };
  }

  return { allowed: true, url: url.toString() };
}
