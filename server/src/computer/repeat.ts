/**
 * How many times a Bot has just made this exact call.
 *
 * A model that cannot get something to work retries. It clicks the same button, reloads the same
 * page, writes the same file, and every one of those attempts is a real action on somebody's live
 * website and a real charge against somebody's model credit. The trail records all thirty of them,
 * one row at a time, with nothing to say that they are the same row thirty times over, so nobody
 * notices until the other side's rate limiter does.
 *
 * This counts, and it does nothing else with the answer. The count goes to the policy, which is the
 * one thing in this codebase allowed to refuse an action. A detector that blocked on its own would
 * be a second boundary with rules of its own, invisible on the Boundaries page, unanswerable to
 * `dry-run`, and impossible to switch off for the one Bot whose job really is to poll something.
 * One boundary, given better information.
 *
 * In memory, and per process, for the same reason the gateway's snapshot cache is: it describes what
 * a Bot did in the last few minutes, and after a restart that question has no useful answer. The
 * loop is over, because whatever was driving it is gone too.
 */

/**
 * How long a call stays counted.
 *
 * Time rather than "this turn", because the gateway has no idea where a turn begins or ends. It is
 * handed one action at a time by whichever route is serving the model, and nothing in that path
 * carries a turn boundary; inventing one would mean threading a conversation id through every acting
 * call to get a worse answer than a clock gives.
 *
 * Three minutes. A retry loop is a model round trip each time round — call the tool, read the
 * failure, decide to try again — which is seconds, not minutes, so ten identical attempts fit inside
 * this comfortably. Much longer and honest repetition starts to accumulate: a Bot told to watch a
 * dashboard reloads the same page all morning and is not stuck. Much shorter and a model that thinks
 * for twenty seconds between attempts never trips anything.
 */
export const DEFAULT_REPEAT_WINDOW_MS = 3 * 60_000;

/**
 * The counts worth writing a row about.
 *
 * Three is "this is now a pattern rather than a retry", ten is "nobody is going to fix this by
 * trying again", twenty-five is "somebody should look". Each fires once, so the trail gains three
 * rows for a Bot stuck all afternoon rather than a row per attempt, which would bury the actions it
 * was taking under the observation that it kept taking them.
 */
export const DEFAULT_REPEAT_THRESHOLDS: readonly number[] = [3, 10, 25];

/**
 * How many distinct calls are remembered per Bot.
 *
 * A Bot doing genuinely varied work never repeats anything, so every call it makes is a new key, and
 * without a cap the map grows for exactly the Bots this feature has nothing to say about. The
 * least recently seen key is dropped, which is the one furthest from tripping anything.
 */
export const DEFAULT_REPEAT_KEYS_PER_BOT = 64;

/**
 * One governed call, in the terms the detector cares about.
 *
 * The same fields the gateway already assembles for the policy and the audit row. Nothing is added
 * to a call site to support this.
 */
export type RepeatedCall = {
  tool: string;
  ref?: string | undefined;
  key?: string | undefined;
  filePath?: string | undefined;
  targetUrl?: string | undefined;
};

export type RepeatObservation = {
  /** Including the call being observed, so the first one counts as one. */
  count: number;
  /**
   * The call's identity, in a form a person can read.
   *
   * Null when nothing distinguished it. See `fingerprintOf`: a bare tool name is not a call worth
   * counting, and the honest count for one of those is a single occurrence.
   */
  fingerprint: string | null;
  /**
   * The threshold this call has just reached, or null on the overwhelming majority of calls.
   *
   * Reported once per run of repetition rather than on every call past it. A count that falls back
   * out of the window and climbs again is a new run and reports again, because it is a Bot that got
   * stuck twice.
   */
  threshold: number | null;
};

export type RepeatDetector = {
  /** Records the call and answers with what it now knows. Never throws, never blocks. */
  observe: (botId: string, call: RepeatedCall) => RepeatObservation;
};

export type RepeatDetectorOptions = {
  windowMs?: number;
  thresholds?: readonly number[];
  maxKeysPerBot?: number;
  /** Injected so a test can move time without waiting for it. */
  now?: () => number;
};

/** One key's history, held only while it is still inside the window. */
type Occurrences = {
  /** When each counted call happened, oldest first. */
  at: number[];
  /** Which thresholds this run of repetition has already reported. */
  reported: Set<number>;
  /** Used to choose what to drop when a Bot is at its key limit. */
  lastSeen: number;
};

export function createRepeatDetector(
  options: RepeatDetectorOptions = {},
): RepeatDetector {
  const windowMs = options.windowMs ?? DEFAULT_REPEAT_WINDOW_MS;
  const maxKeysPerBot = options.maxKeysPerBot ?? DEFAULT_REPEAT_KEYS_PER_BOT;
  // Ascending, so the loop below ends on the highest threshold a call crossed rather than on
  // whichever one the caller happened to list last.
  const thresholds = [
    ...(options.thresholds ?? DEFAULT_REPEAT_THRESHOLDS),
  ].sort((a, b) => a - b);
  const clock = options.now ?? Date.now;

  /**
   * Per Bot, then per call.
   *
   * Nested rather than keyed on a combined string so that one Bot's varied work cannot push another
   * Bot's history out: the cap is per Bot, and a shared map would make it a race between them. The
   * outer map is bounded by how many Bots a deployment has, which is a list somebody wrote down.
   */
  const perBot = new Map<string, Map<string, Occurrences>>();

  return {
    observe(botId, call) {
      const fingerprint = fingerprintOf(call);
      if (!fingerprint) {
        return { count: 1, fingerprint: null, threshold: null };
      }

      const now = clock();
      let calls = perBot.get(botId);
      if (!calls) {
        calls = new Map<string, Occurrences>();
        perBot.set(botId, calls);
      }

      let entry = calls.get(fingerprint);
      if (!entry) {
        if (calls.size >= maxKeysPerBot) {
          evictLeastRecent(calls);
        }
        entry = { at: [], reported: new Set<number>(), lastSeen: now };
        calls.set(fingerprint, entry);
      }

      const cutoff = now - windowMs;
      entry.at = entry.at.filter((time) => time > cutoff);
      if (entry.at.length === 0) {
        // Nothing survived the window, so whatever run of repetition this key was in has ended and
        // its thresholds are free to report again. Without this a Bot that got stuck, recovered and
        // got stuck again an hour later would leave one row for two incidents.
        entry.reported.clear();
      }
      entry.at.push(now);
      entry.lastSeen = now;

      const count = entry.at.length;
      let threshold: number | null = null;
      for (const candidate of thresholds) {
        if (count >= candidate && !entry.reported.has(candidate)) {
          entry.reported.add(candidate);
          threshold = candidate;
        }
      }

      return { count, fingerprint, threshold };
    },
  };
}

/**
 * What makes two calls the same call.
 *
 * The tool name is not enough, and a detector keyed on it alone would be worse than none: five
 * clicks may be five different buttons, so a Bot working steadily down a form would look exactly
 * like one stuck on its first field, and the first person to see a rule fire on that would turn the
 * feature off. So the key is the tool plus the argument saying WHICH thing it acted on — the ref,
 * the key pressed, the file path, the address being opened — and a call carrying none of those is
 * not counted at all.
 *
 * Deliberately absent: the text being typed. A Bot that fills the same field thirty times is worth
 * catching, but what it filled it with is a password as often as it is anything else, and from here
 * the fingerprint travels into an audit row. The cost is that thirty different values into one field
 * read as thirty repeats, which is the direction to be wrong in.
 *
 * A ref only means anything against the snapshot it came from. A page that re-renders and hands back
 * a different ref for the same button reads as a different call, so a Bot looping around a reload is
 * undercounted. Keying on the element's label instead would follow the button across snapshots and
 * merge two buttons that share a label, and a count that is sometimes low is easier to live with
 * than one that is sometimes about the wrong thing.
 *
 * Readable, because it goes on the audit row as-is. An investigator reading "the same action 25
 * times" needs to be told which action without going and decoding a hash.
 */
export function fingerprintOf(call: RepeatedCall): string | null {
  const parts: string[] = [];
  const add = (label: string, value: string | undefined) => {
    const normalized = normalize(value);
    if (normalized) parts.push(`${label}=${normalized}`);
  };

  add("ref", call.ref);
  add("key", call.key);
  add("file", call.filePath);
  add("url", call.targetUrl);

  if (parts.length === 0) return null;
  return [normalize(call.tool) || call.tool, ...parts].join(" ");
}

/**
 * Whitespace collapsed and trimmed.
 *
 * A model reproducing an argument from its own earlier output does not always reproduce the spacing,
 * and a Bot writing to `reports/q3.md` and to `reports/q3.md ` is doing one thing twice. Treating
 * those as two calls would let a stuck Bot slip the count without changing anything about what it
 * was actually doing.
 */
function normalize(value: string | undefined): string {
  return (value ?? "").replaceAll(/\s+/g, " ").trim();
}

/** The key a Bot touched longest ago, which is the one least likely to be part of a live loop. */
function evictLeastRecent(calls: Map<string, Occurrences>) {
  let oldestKey: string | null = null;
  let oldestSeen = Number.POSITIVE_INFINITY;
  for (const [key, entry] of calls) {
    if (entry.lastSeen < oldestSeen) {
      oldestSeen = entry.lastSeen;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) calls.delete(oldestKey);
}
