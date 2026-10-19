// Which network calls a recording keeps: the ones the person's own action causes. Network capture exists so a Bot can
// later do the task through the site's API, so a recording holds the request behind a click, a submit or an Enter, its
// response, and the calls that response starts in turn; never what the page does on its own (telemetry, polling,
// prefetch, a call it already made, an aborted call, or anything it starts while the person does nothing).
//
// Chrome gives no reliable link from a call to the input that caused it: CDP's `initiator` only says whether a script
// or the parser started the call (its stack needs the Debugger domain, and holds no trace of the event that ran it), and
// `hasUserGesture` stays true for five seconds after any input in the frame. So the link is drawn in time, per tab:
//
// - a call that starts within `windowMs` of an action in its tab is that action's;
// - a call that starts while a kept call's response arrives, or within `chainGapMs` after it ended, continues the chain
//   (a request made from the previous one's response handler), at most `maxDepth` links and `horizonMs` from the action;
// - an action reaches the service worker a little after the call it caused can, so a call with no action yet waits up
//   to `waitMs` from its start for one before it is dropped.
//
// Both capture paths (the debugger and the page-level hook) put every call through one gate.
import { isPrefetch, isTelemetry } from "./telemetry";

export const CAUSALITY = {
  /** A call starting this long after an action in its tab is the action's. */
  windowMs: 1_000,
  /** A call starting this long after a kept call ended continues that call's chain. */
  chainGapMs: 250,
  /** How many links a chain may add after the action's own calls. */
  maxDepth: 2,
  /** No chain runs longer than this after its action. */
  horizonMs: 3_000,
  /** How long a call with no action yet waits for one to arrive. */
  waitMs: 1_000,
  /** A call the tab already made this recently is the page's own repeat (polling, a refresh of what it has). */
  repeatLookbackMs: 10 * 60_000,
} as const;

export type CausalityTuning = { [key in keyof typeof CAUSALITY]: number };

/** Why a call was dropped, or "kept". */
export type Verdict =
  | "kept"
  | "aborted"
  | "telemetry"
  | "prefetch"
  | "repeat"
  | "unprompted";

/** A finished call's timing, epoch milliseconds. */
export type CallTiming = {
  tabId: number;
  startedAt: number;
  /** When its response began to arrive; absent when only the end is known. */
  respondedAt?: number;
  endedAt: number;
};

/** What the cheap checks need, before any body is read. */
export type CallFacts = {
  url: string;
  method: string;
  outcome: "ok" | "error" | "aborted";
  headers: Record<string, string>;
  body?: string;
  /** The tab already made this exact call: see `CausalityGate.seen`. */
  repeat: boolean;
};

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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

/** A 53-bit hash (cyrb53): the gate remembers calls by hash only, never their URL or body. */
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

/** The checks that need no timing: they run before a body is read, so a dropped call costs nothing. */
export function screenCall(
  facts: CallFacts,
): Exclude<Verdict, "kept" | "unprompted"> | null {
  if (facts.outcome === "aborted") return "aborted";
  if (isTelemetry(facts.url, facts.body)) return "telemetry";
  if (isPrefetch(facts.headers)) return "prefetch";
  if (facts.repeat) return "repeat";
  return null;
}

type Link = {
  /** The chain's action. */
  anchor: number;
  depth: number;
  respondedAt: number;
  endedAt: number;
};
/** What a kept call is tied to: its action's time, and how many calls into that action's chain it sits (0: first). */
export type Cause = { anchor: number; depth: number };

type Held = {
  call: CallTiming;
  deliver: (cause: Cause) => void;
  drop: (verdict: Verdict) => void;
  timer: unknown;
};
type TabState = {
  actions: number[];
  links: Link[];
  seen: Map<number, number[]>;
  held: Held[];
};

/** How long actions and kept calls are remembered: longer than any call a page keeps open. */
const RETENTION_MS = 120_000;
const MAX_ACTIONS = 256;
const MAX_LINKS = 256;
const MAX_SEEN = 4_000;
const SEEN_STARTS = 4;

export type CausalityGate = ReturnType<typeof createCausalityGate>;

export function createCausalityGate(
  options: {
    now?: () => number;
    timers?: Timers;
    tuning?: Partial<CausalityTuning>;
  } = {},
) {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const tune: CausalityTuning = { ...CAUSALITY, ...options.tuning };
  const tabs = new Map<number, TabState>();

  const tabOf = (tabId: number): TabState => {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { actions: [], links: [], seen: new Map(), held: [] };
      tabs.set(tabId, tab);
    }
    return tab;
  };

  /** The action, or the kept call, that this call continues; null when it has none. */
  function causeOf(tab: TabState, call: CallTiming): Cause | null {
    const start = call.startedAt;
    let best: Cause | null = null;
    for (const at of tab.actions)
      if (at <= start && start - at <= tune.windowMs)
        if (!best || at > best.anchor) best = { anchor: at, depth: 0 };
    if (best) return best;
    for (const link of tab.links) {
      if (link.depth >= tune.maxDepth) continue;
      if (start < link.respondedAt || start > link.endedAt + tune.chainGapMs)
        continue;
      if (start - link.anchor > tune.horizonMs) continue;
      if (!best || link.depth + 1 < best.depth)
        best = { anchor: link.anchor, depth: link.depth + 1 };
    }
    return best;
  }

  function keep(tab: TabState, call: CallTiming, cause: Cause) {
    tab.links.push({
      ...cause,
      respondedAt: call.respondedAt ?? call.endedAt,
      endedAt: call.endedAt,
    });
    if (tab.links.length > MAX_LINKS) tab.links.shift();
  }

  /** Delivers every held call of the tab that now has a cause, oldest first; a kept call can be the next one's cause. */
  function recheck(tab: TabState): void {
    let changed = true;
    while (changed) {
      changed = false;
      tab.held.sort((a, b) => a.call.startedAt - b.call.startedAt);
      for (const held of [...tab.held]) {
        const cause = causeOf(tab, held.call);
        if (!cause) continue;
        tab.held.splice(tab.held.indexOf(held), 1);
        timers.clear(held.timer);
        keep(tab, held.call, cause);
        held.deliver(cause);
        changed = true;
      }
    }
  }

  /** A call is judged when it ends, by when it started: a long one (a streamed answer) still needs its action. */
  function prune(tab: TabState): void {
    const oldest = now() - RETENTION_MS;
    tab.actions = tab.actions.filter((at) => at >= oldest);
    tab.links = tab.links.filter((link) => link.anchor >= oldest);
  }

  return {
    /** The person did something in the tab at `at` (epoch ms): a click, an edit, a submit, an Enter in a field. */
    action(tabId: number, at: number): void {
      const tab = tabOf(tabId);
      prune(tab);
      tab.actions.push(at);
      if (tab.actions.length > MAX_ACTIONS) tab.actions.shift();
      recheck(tab);
    },

    /** Remembers that the tab made this call at `startedAt`; true when it already made the same one before then. */
    seen(tabId: number, signature: number, startedAt: number): boolean {
      const tab = tabOf(tabId);
      const starts = tab.seen.get(signature) ?? [];
      const repeat = starts.some(
        (at) => at < startedAt && startedAt - at <= tune.repeatLookbackMs,
      );
      tab.seen.delete(signature);
      tab.seen.set(signature, [...starts, startedAt].slice(-SEEN_STARTS));
      if (tab.seen.size > MAX_SEEN) {
        const oldest = tab.seen.keys().next();
        if (!oldest.done) tab.seen.delete(oldest.value);
      }
      return repeat;
    },

    /** A call that passed `screenCall`: delivered at once when an action caused it, held a moment when its action may
     * still be on its way, else dropped as the page's own. */
    admit(
      call: CallTiming,
      deliver: (cause: Cause) => void,
      drop: (verdict: Verdict) => void = () => {},
    ): void {
      const tab = tabOf(call.tabId);
      prune(tab);
      const cause = causeOf(tab, call);
      if (cause) {
        keep(tab, call, cause);
        deliver(cause);
        recheck(tab);
        return;
      }
      const wait = call.startedAt + tune.waitMs - now();
      if (wait <= 0) {
        drop("unprompted");
        return;
      }
      const held: Held = { call, deliver, drop, timer: undefined };
      held.timer = timers.set(() => {
        const index = tab.held.indexOf(held);
        if (index === -1) return;
        tab.held.splice(index, 1);
        drop("unprompted");
      }, wait);
      tab.held.push(held);
    },

    forgetTab(tabId: number): void {
      const tab = tabs.get(tabId);
      if (!tab) return;
      for (const held of tab.held) timers.clear(held.timer);
      tabs.delete(tabId);
    },

    clear(): void {
      for (const tab of tabs.values())
        for (const held of tab.held) timers.clear(held.timer);
      tabs.clear();
    },
  };
}
