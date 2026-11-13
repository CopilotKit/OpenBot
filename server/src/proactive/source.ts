import { isLoopbackHost } from "@openbot/shared/this-machine";

/**
 * A check-in on one public web page: the address it reads, as given, when it is one.
 *
 * Only `http` and `https`, and not this machine or a private network. The read happens at the
 * research provider, not here, so this is a courtesy that says the obvious mistake back to the
 * person, not the boundary: what bounds a page check-in is that the one address is fixed when it is
 * made and checked at the door (`plugins/plugin-store/calls.ts`).
 */
export function publicPageAddress(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || isLoopbackHost(host) || privateHost(host)) return null;
  return url.href;
}

function privateHost(host: string): boolean {
  if (host.includes(":"))
    return (
      host === "::" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80") ||
      host.startsWith("::ffff:")
    );
  // A bare name ("intranet") or a `.local`, `.localhost` or `.internal` one is a private network's.
  if (
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 0 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return false;
}

/** The host a page check-in reads, as its row says it: "Reads github.com". */
export function pageHost(link: string | null): string | null {
  if (!link) return null;
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
