import { createHash } from "node:crypto";
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

/**
 * How much of a page a `page` check-in keeps and compares. A longer page is compared on what fits:
 * a change past this point is not seen, which is the price of keeping one page's text per check-in.
 */
export const PAGE_KEPT_CHARS = 50_000;

/**
 * A page's text as it is kept and compared: whitespace runs collapsed, trimmed and capped. Spacing a
 * provider reflows between two reads is not a change to the person.
 */
export function normalisedPage(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PAGE_KEPT_CHARS);
}

/** The hash a page's kept text is compared by. */
export function pageHashOf(normalised: string): string {
  return createHash("sha256").update(normalised).digest("hex");
}

/**
 * The arguments a page-read tool takes for one address. Firecrawl's scrape takes `url`; Parallel's
 * and Exa's fetch take a list, `urls`, given just this one.
 */
export function pageReadArgs(
  ref: string,
  link: string,
): Record<string, unknown> {
  return ref.split("/")[0]?.startsWith("firecrawl")
    ? { url: link }
    : { urls: [link] };
}

/**
 * The one address a page-read call asks for, or null when it asks for none or for more than one:
 * `url`, or `urls` holding exactly one. What the door compares with a check-in's own address.
 */
export function addressOfPageRead(
  args: Record<string, unknown>,
): string | null {
  if (typeof args.url === "string")
    return Array.isArray(args.urls) ? null : args.url;
  if (
    Array.isArray(args.urls) &&
    args.urls.length === 1 &&
    typeof args.urls[0] === "string"
  )
    return args.urls[0];
  return null;
}
