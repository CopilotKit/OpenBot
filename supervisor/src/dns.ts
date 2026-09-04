/**
 * IPv4 blocks reserved for non-general use by IANA, plus multicast.
 *
 * DNS resolvers must be ordinary public unicast addresses. Even the special-purpose anycast
 * assignments that IANA marks globally reachable are not general resolver space, so the containing
 * special block stays outside this deployment boundary.
 *
 * https://www.iana.org/assignments/iana-ipv4-special-registry
 */
const SPECIAL_IPV4_RANGES = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 31, 196, 0], 24],
  [[192, 52, 193, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[192, 175, 48, 0], 24],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
] as const;

function ipv4Number(parts: readonly number[]): number {
  return parts.reduce((value, part) => value * 256 + part, 0);
}

function isInIpv4Range(
  address: number,
  [networkParts, prefix]: (typeof SPECIAL_IPV4_RANGES)[number],
): boolean {
  const network = ipv4Number(networkParts);
  const size = 2 ** (32 - prefix);
  return address >= network && address < network + size;
}

function isPublicIpv4(value: string): boolean {
  const rawParts = value.split(".");
  if (
    rawParts.length !== 4 ||
    rawParts.some((part) => !/^\d{1,3}$/.test(part))
  ) {
    return false;
  }
  const parts = rawParts.map(Number);
  if (parts.some((part) => part > 255)) return false;
  const address = ipv4Number(parts);
  return !SPECIAL_IPV4_RANGES.some((range) => isInIpv4Range(address, range));
}

/**
 * Resolvers are deployment configuration, never input from a Bot. Keeping them
 * public prevents a managed browser from using DNS as a route into Tailnet or
 * private infrastructure.
 */
export function parseComputerDnsServers(raw?: string): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  return raw.split(",").flatMap((entry) => {
    const resolver = entry.trim();
    if (!isPublicIpv4(resolver)) {
      throw new Error(
        `COMPUTER_DNS_SERVERS contains an invalid resolver: ${entry}`,
      );
    }
    if (seen.has(resolver)) return [];
    seen.add(resolver);
    return [resolver];
  });
}
