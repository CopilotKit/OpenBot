const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function isTailnetIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  return (
    octets.every((octet) => octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

/**
 * Static hosts are deployment configuration, never supplied by a Bot. Managed
 * computers use them for an approved Tailnet service without receiving a
 * general DNS escape hatch.
 */
export function parseComputerExtraHosts(raw?: string): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  return raw.split(",").map((entry) => {
    const [rawHost, address, extra] = entry.trim().split("=");
    const hostname = rawHost?.toLowerCase();
    if (
      !hostname ||
      !address ||
      extra ||
      !HOSTNAME.test(hostname) ||
      !isTailnetIpv4(address) ||
      seen.has(hostname)
    ) {
      throw new Error(
        `COMPUTER_EXTRA_HOSTS contains an invalid mapping: ${entry}`,
      );
    }
    seen.add(hostname);
    return `${hostname}:${address}`;
  });
}
