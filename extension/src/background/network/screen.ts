// The checks a network call passes before it can be a step's save: never an aborted call, telemetry, analytics, ads or
// monitoring, a prefetch, or a read the tab already made (polling, a refresh of what the page has). A write the tab
// already made is still the person's: archiving twice is two saves. They need no body and no timing, so a call they
// drop costs nothing more.
import { isPrefetch, isTelemetry } from "./telemetry";

/** A call the tab already made this recently is the page's own repeat. */
export const REPEAT_LOOKBACK_MS = 10 * 60_000;

/** Why a call can never be a save. */
export type Screened = "aborted" | "telemetry" | "prefetch" | "repeat";

/** What the checks need. */
export type CallFacts = {
  url: string;
  method: string;
  outcome: "ok" | "error" | "aborted";
  headers: Record<string, string>;
  body?: string;
  /** The tab already made this exact call: see `createRepeatMemory`. Screens a read only. */
  repeat: boolean;
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Query parameters that only bust a cache: two calls differing only in these are the same call. */
const CACHE_BUSTERS = new Set([
  "_",
  "t",
  "ts",
  "timestamp",
  "cb",
  "cachebuster",
  "cache_buster",
  "nocache",
  "rnd",
  "rand",
  "random",
  "_t",
  "_ts",
]);
const EPOCH = /^\d{10}(?:\d{3})?$/;

/** A 53-bit hash (cyrb53): calls are remembered by hash only, never their URL or body. */
function hash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** One call's identity: method, URL without its fragment or cache busters, and request body. */
export function callSignature(
  method: string,
  url: string,
  body: string | undefined,
): number {
  let address = url;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const [key, item] of [...parsed.searchParams])
      if (CACHE_BUSTERS.has(key.toLowerCase()) || EPOCH.test(item))
        parsed.searchParams.set(key, "*");
    address = parsed.href;
  } catch {
    // Not a URL: the text itself is the identity.
  }
  return hash(`${method.toUpperCase()} ${address}\n${body ?? ""}`);
}

export function screenCall(facts: CallFacts): Screened | null {
  if (facts.outcome === "aborted") return "aborted";
  if (isTelemetry(facts.url, facts.body)) return "telemetry";
  if (isPrefetch(facts.headers)) return "prefetch";
  // A page polls and refreshes by reading; a write is the person's doing each time, however often it was made before.
  if (facts.repeat && !WRITE_METHODS.has(facts.method.toUpperCase()))
    return "repeat";
  return null;
}

const MAX_SEEN = 4_000;
const SEEN_STARTS = 4;

/** Which calls each tab already made, by signature: a repeat is the page polling or refreshing what it has. */
export function createRepeatMemory() {
  const tabs = new Map<number, Map<number, number[]>>();
  return {
    /** Remembers that the tab made this call at `startedAt`; true when it already made the same one before then. */
    seen(tabId: number, signature: number, startedAt: number): boolean {
      let seen = tabs.get(tabId);
      if (!seen) {
        seen = new Map();
        tabs.set(tabId, seen);
      }
      const starts = seen.get(signature) ?? [];
      const repeat = starts.some(
        (at) => at < startedAt && startedAt - at <= REPEAT_LOOKBACK_MS,
      );
      seen.delete(signature);
      seen.set(signature, [...starts, startedAt].slice(-SEEN_STARTS));
      if (seen.size > MAX_SEEN) {
        const oldest = seen.keys().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      return repeat;
    },
    forgetTab(tabId: number): void {
      tabs.delete(tabId);
    },
    clear(): void {
      tabs.clear();
    },
  };
}

export type RepeatMemory = ReturnType<typeof createRepeatMemory>;
