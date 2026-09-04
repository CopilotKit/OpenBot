function isPublicIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const [first, second] = parts.map(Number);
  if (parts.some((part) => Number(part) > 255)) return false;
  if ([0, 10, 100, 127, 224, 255].includes(first)) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  return !(first === 192 && second === 168);
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
