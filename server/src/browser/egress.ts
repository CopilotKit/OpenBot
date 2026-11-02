import { isIP } from "node:net";
import type { EgressPolicy, EgressRule } from "../computer/policy-network";

/**
 * Where a person's own browser may go, pushed to its computer the way a Bot's policy is (computer/policy-network.ts).
 *
 * A PERSON'S BROWSER IS NOT A BOT'S. The organization's network policy says where Bots may go, and a person's own browser
 * is for whatever they browse, so it is not held to it. It reaches what the person's browser on their own laptop would:
 *
 * - On their own desktop (OpenBot Desktop's host-side computer), everything: it is their machine and their network.
 * - On a computer in the cloud, the open internet and nothing inside the deployment, which a laptop could never reach
 *   either: the database, another pod, a node or a cloud metadata endpoint. The same line the chart's NetworkPolicy
 *   draws for computers (charts/openbot/templates/networkpolicy.yaml), and the one OWASP's SSRF guidance draws for a
 *   service that must reach any public address: allow what is public, refuse private and reserved space. Written as
 *   the public ranges, because a policy here can only allow; the computer's filter checks every address a name
 *   resolves to and connects to the address it checked, so a name that points inside is refused too.
 * - Plus OpenBot itself and the Intelligence gateway, wherever they resolve: the Recorder reaches OpenBot for its capture
 *   passes and streams to the gateway, and either can sit on a private address inside the cluster. Their origins only,
 *   host and port: OpenBot and the gateway often share an address with other services (the Intelligence UI, a
 *   database, every other port on 127.0.0.1), and a person's browser is let in to these two, not to their neighbours.
 *
 * A deployment that lets Bots reach private addresses (AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS, local development only) lets a
 * person's cloud browser reach everything too.
 */
export function personBrowserEgressPolicy(input: {
  /** The browser is a window on the person's own desktop. */
  native: boolean;
  allowPrivateHosts: boolean;
  /** This OpenBot's addresses (its public URL and its app's). */
  openbotUrls: readonly (string | undefined)[];
  /** INTELLIGENCE_GATEWAY_WS_URL. */
  gatewayUrl: string;
}): EgressPolicy {
  if (input.native || input.allowPrivateHosts)
    return { mode: "allow_all", rules: [] };
  return {
    mode: "allowlist_only",
    rules: [
      ...recorderOriginRules(input),
      ...publicInternetRanges().map(
        (value): EgressRule => ({ type: "cidr", value }),
      ),
    ],
  };
}

/**
 * What the Recorder in a browser must reach, as rules: OpenBot itself, for its capture passes, and the Intelligence
 * gateway, which it streams to. Their origins only, host and port, for the reason given above.
 */
export function recorderOriginRules(input: {
  /** This OpenBot's addresses (its public URL and its app's). */
  openbotUrls: readonly (string | undefined)[];
  /** INTELLIGENCE_GATEWAY_WS_URL. */
  gatewayUrl: string;
}): EgressRule[] {
  return uniqueRules(
    [...input.openbotUrls, input.gatewayUrl].flatMap((raw) => {
      const origin = originOf(raw);
      return origin ? rulesFor(origin) : [];
    }),
  );
}

/**
 * A Bot's own policy with the Recorder's origins let through as well: what a Bot's computer is pushed while a person
 * records in its browser (browser/bot-browser.ts). Only ever wider, and by those origins alone. A policy that allows
 * everything already allows them; one that allows nothing (the owner's "Cloud network access" is off) allows them and
 * nothing else; an allowlist gains them beside its own rules.
 */
export function withRecorderOrigins(
  policy: EgressPolicy,
  rules: readonly EgressRule[],
): EgressPolicy {
  if (policy.mode === "allow_all" || rules.length === 0) return policy;
  if (policy.mode === "deny_all")
    return { mode: "allowlist_only", rules: [...rules] };
  return { mode: policy.mode, rules: uniqueRules([...policy.rules, ...rules]) };
}

/** The port a URL reaches when it names none: the gateway's address is a ws: or wss: one. */
const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
};

type Origin = { host: string; port: number };

function originOf(raw: string | undefined): Origin | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  return host && port ? { host, port } : null;
}

/**
 * Each is allowed on its own port only. An address is allowed as itself, since a domain rule never matches an address,
 * and `localhost` is this machine's loopback addresses, which is what it reaches.
 *
 * A name is allowed by name on its port (a domain rule also covers the names under it, on that port). Where the name
 * resolves to a public address the open web already allows it on every port; the port matters where it resolves inside
 * the deployment, which is the case this rule is for.
 */
function rulesFor({ host, port }: Origin): EgressRule[] {
  const addresses = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
  if (addresses.some((address) => isIP(address) === 0))
    return [{ type: "domain", value: host, ports: String(port) }];
  return addresses.map((address) => ({
    type: "cidr",
    value: `${address}/${isIP(address) === 4 ? 32 : 128}`,
    ports: String(port),
  }));
}

function uniqueRules(rules: EgressRule[]): EgressRule[] {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.type}:${rule.value}:${rule.ports ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every address range that is not the public internet, from IANA's special-purpose registries
 * (https://www.iana.org/assignments/iana-ipv4-special-registry, iana-ipv6-special-registry): this network, private
 * space, shared carrier space (where Alibaba keeps its metadata endpoint), loopback, link-local (every other cloud's),
 * protocol assignments, documentation and benchmarking ranges, the deprecated relays that can carry a private address
 * inside a public-looking one, multicast and the reserved rest.
 */
const NOT_PUBLIC_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];
/** Inside 2000::/3, the only IPv6 space that is global unicast at all (unique-local, link-local, loopback, mapped and
 * NAT64 addresses all sit outside it). */
const NOT_PUBLIC_IPV6 = ["2001::/23", "2001:db8::/32", "2002::/16"];

let publicRanges: string[] | null = null;

/** The public internet as CIDR ranges: all of IPv4 but the ranges above, and IPv6 global unicast but the ones above. */
export function publicInternetRanges(): string[] {
  publicRanges ??= [
    ...rangesOutside(IPV4, "0.0.0.0/0", NOT_PUBLIC_IPV4),
    ...rangesOutside(IPV6, "2000::/3", NOT_PUBLIC_IPV6),
  ];
  return publicRanges;
}

type Family = {
  bits: number;
  parse(address: string): bigint;
  format(value: bigint): string;
};

const IPV4: Family = {
  bits: 32,
  parse: (address) =>
    address
      .split(".")
      .reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n),
  format: (value) =>
    [24n, 16n, 8n, 0n]
      .map((shift) => String((value >> shift) & 255n))
      .join("."),
};

const IPV6: Family = {
  bits: 128,
  parse: (address) => {
    const [head = "", tail] = address.split("::");
    const groups = (part: string) => (part ? part.split(":") : []);
    const all =
      tail === undefined
        ? groups(head)
        : [
            ...groups(head),
            ...Array<string>(
              8 - groups(head).length - groups(tail).length,
            ).fill("0"),
            ...groups(tail),
          ];
    return all.reduce(
      (value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)),
      0n,
    );
  },
  format: (value) =>
    Array.from({ length: 8 }, (_, index) =>
      ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
    ).join(":"),
};

function bounds(family: Family, cidr: string): [bigint, bigint] {
  const [address = "", prefix = String(family.bits)] = cidr.split("/");
  const size = 1n << BigInt(family.bits - Number(prefix));
  const start = family.parse(address);
  return [start, start + size - 1n];
}

/** `universe` without `cut`, as the fewest CIDR ranges that cover exactly what is left. */
function rangesOutside(
  family: Family,
  universe: string,
  cut: readonly string[],
): string[] {
  const [low, high] = bounds(family, universe);
  const removed = cut
    .map((cidr) => bounds(family, cidr))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const kept: string[] = [];
  let next = low;
  for (const [start, end] of removed) {
    if (end < next) continue;
    if (start > high) break;
    if (start > next) kept.push(...blocks(family, next, start - 1n));
    next = end + 1n;
  }
  if (next <= high) kept.push(...blocks(family, next, high));
  return kept;
}

/** The addresses from `start` to `end` as the largest aligned blocks, in order. */
function blocks(family: Family, start: bigint, end: bigint): string[] {
  const out: string[] = [];
  let at = start;
  while (at <= end) {
    let size = 1n;
    let prefix = family.bits;
    while (prefix > 0) {
      const bigger = size << 1n;
      if (at % bigger !== 0n || at + bigger - 1n > end) break;
      size = bigger;
      prefix -= 1;
    }
    out.push(`${family.format(at)}/${prefix}`);
    at += size;
  }
  return out;
}
