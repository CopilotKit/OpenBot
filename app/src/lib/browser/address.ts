/** Where words that are not an address are looked up: Chrome's own default, since the browser behind the page is
 * Chrome or Chromium and a person typing a question into its address bar expects what Chrome does with it. */
const SEARCH = "https://www.google.com/search?q=";

/** An address that already says how to reach it. `localhost:3000` is not one: its `localhost:` is a host, not a
 * scheme, so only a scheme followed by `//`, or one of the few that never take it, counts. */
const HAS_SCHEME =
  /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:about|data|mailto|view-source):)/i;

/** A host with no spaces (a name with a dot in it, `localhost`, or a bracketed IPv6 address), perhaps with a port and
 * a path. */
const LOOKS_LIKE_HOST =
  /^(?:\[[0-9a-f:.]+\]|[^\s/?#:]+\.[^\s/?#:]+|localhost)(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * What the address bar sends for what the person typed, as Chrome's address bar reads it: an address as it is, a
 * bare host as https, and anything else as a search. `null` for nothing typed.
 */
export function addressFrom(typed: string): string | null {
  const text = typed.trim();
  if (!text) return null;
  if (HAS_SCHEME.test(text)) return text;
  if (LOOKS_LIKE_HOST.test(text)) return `https://${text}`;
  return `${SEARCH}${encodeURIComponent(text)}`;
}
