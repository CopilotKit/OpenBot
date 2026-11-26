export const UNBIASED_SHUTDOWN_AT = Date.parse("2026-11-27T17:00:00Z");

export function isUnbiasedHost(host: string | null | undefined): boolean {
  return (
    host?.split(":")[0]?.toLowerCase().replace(/\.$/, "") === "api.unbiased.ai"
  );
}

export function isUnbiasedEndpoint(
  address: string | null | undefined,
): boolean {
  if (!address) return false;
  try {
    return isUnbiasedHost(new URL(address.trim()).hostname);
  } catch {
    return false;
  }
}

export function unbiasedShutdownMessage(now = Date.now()): string {
  return now < UNBIASED_SHUTDOWN_AT
    ? "Unbiased AI stops serving models Friday, November 27 at noon EST."
    : "Unbiased AI has shut down.";
}

export function unbiasedShutdownNotice(): string {
  return `${unbiasedShutdownMessage()} Choose a replacement for your Bots.`;
}
