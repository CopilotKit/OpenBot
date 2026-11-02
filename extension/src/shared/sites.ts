// The sites a person keeps out of their recordings. A site is what browsers call one, the registrable domain
// (https://web.dev/articles/same-site-same-origin): the part a company buys (bank.example.co.uk for
// online.bank.example.co.uk), so one click on a bank's sign-in page also leaves out the account pages it moves to on
// another of its own hosts. The Public Suffix List decides where a registrable domain begins, read with tldts
// (https://github.com/remusao/tldts), its private section included, so one person's github.io pages are not every
// person's. An address with no registrable domain (an IP address, a single-label host) is its own host.
import { getDomain } from "tldts";

/** The site an address belongs to, or null for one that is not a website (chrome://, a data: URL, nonsense). */
export function siteOf(url: string | undefined | null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!host) return null;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** Whether `url` is on a site the person keeps out of their recordings. */
export function isExcludedSite(
  url: string | undefined | null,
  sites: ReadonlySet<string>,
): boolean {
  if (sites.size === 0) return false;
  const site = siteOf(url);
  return site !== null && sites.has(site);
}

/** A stored list as the Recorder keeps it: each entry a site as `siteOf` names one, once, sorted. */
export function normaliseSites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const sites = new Set<string>();
  for (const entry of value)
    if (typeof entry === "string") {
      const site = siteOf(`https://${entry.trim().toLowerCase()}/`);
      if (site !== null && site === entry.trim().toLowerCase()) sites.add(site);
    }
  return [...sites].sort();
}
