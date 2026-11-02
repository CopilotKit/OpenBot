// A recording is the person's steps: each click, edit, choice, submit, Enter and top-frame page change, in order, so an
// agent can be trained to do the same clicks and enter the same data. A step that saved something carries the one
// request it sent to save it, so the agent also learns what the save looks like; the page's other traffic is never
// recorded.
//
// A step is held until its window closes (or the next step in its tab starts) and every call it may own has arrived,
// then sent with its request in place; steps leave in the order they came. An event that is not a step (the agent's
// side, agent/events.ts) is placed among them by its time: it leaves after every step that came before it and before
// every later one, so the order Intelligence numbers them in is the order they happened. A step whose `settle` still
// awaits what the page may start for it (a Send's run, after a call of the page's own) is held for its join: until that
// comes, the person's next step begins, or `horizonMs` + `settleMs` pass, as long as a step nothing follows is held.
//
// Which calls a step owns is drawn in time, per tab, since Chrome gives no reliable link from a call to the input that
// caused it: a call is the latest step's when it starts no earlier than `leadMs` before that step (a handler can run on
// pointerdown, before the click), and either within `windowMs` of it or within `chainGapMs` of the end of a call the
// step already owns (a request made from the previous one's response), at most `maxDepth` links and `horizonMs` from
// the step. Of those, the save is a write that sounds like one:
// - PUT, PATCH or DELETE;
// - a GraphQL mutation (never a query);
// - a POST whose masked body carries what the person just typed or chose, or whose path or operation is a write
//   (create, update, save, delete, send, submit, mark, archive, assign, verify, confirm, redeem). What they typed into a
//   sensitive field (a password, a card, a code) counts though its body holds it only as [redacted]: the network capture
//   marks the exchange as it masks it (`typed`). Apps read their configuration through POSTs too, and those stay out;
// - a form the top frame posted as a page load (a classic sign-in), whatever its address.
// When several qualify, the one carrying the person's values wins, else the first. A write the page sends to keep itself
// alive or to report on itself (presence, heartbeats, pings, typing, session refreshes, telemetry, tracking, logs) is
// never a save.
//
// Page changes the page makes one after another, with no step of the person's between them and none more than
// `redirectMs` after the last (a sign-in's redirects, an app settling on its default view), are one step to the final
// page, `from` the address the chain began at. A reload, a step back or forward, or an address the person typed or
// picked in the browser is never the page's: it starts a step of its own.
//
// A page the person arrives on and has not acted on yet is a visit: it stays held for as long as they stay on its site,
// and so does everything after it, since nothing leaves ahead of what came before it. The visit ends, and what it held
// goes out with its own times, at the person's first step (there or in another tab), when they move to another tab,
// when a page of another site arrives in the tab, when the tab closes, or when the recording stops. Until then, leaving
// the site out (`dropTab`) drops all of it: a glance at a bank or a mailbox while recording never leaves the browser if
// the person leaves its site out before they act or move on. A redirect the page makes is the same visit, wherever it
// goes on the way.
//
// The person's narration is placed the same way: a phrase's transcript is stamped with the phrase's start, but exists
// only once the phrase ends, seconds later. While a phrase is being spoken (`hold`), nothing from its start on leaves
// until its transcript is placed, or `speechCapMs` after its start at most, so it goes in ahead of the steps taken while
// it was said.
//
// What is held can be written down (`snapshot`) and taken up again by a new assembler (`restore`), under the same rules:
// a service worker that restarts, or a browser that quits, still sends every step it held.
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  type JsonValue,
  REDACTED,
  trimEvent,
} from "@openbot/shared/recorder-masking";
import { siteOf } from "../shared/sites";

export const STEP_TIMING = {
  /** A call starting this long after a step is the step's. */
  windowMs: 1_000,
  /** A call starting this long after one of the step's calls ended continues the step's chain. */
  chainGapMs: 250,
  /** How many links a chain may add after the step's own calls. */
  maxDepth: 2,
  /** No chain runs longer than this after its step, and no step waits longer than this for another to close it. */
  horizonMs: 3_000,
  /** How long before its step a call may start and still be the step's (a pointerdown handler, before the click). */
  leadMs: 250,
  /** How long a closed step waits for its calls (and a coalesced edit before it) to arrive. */
  settleMs: 1_000,
  /** How long a page change waits for the next one the page makes on its own (a redirect) before it is sent, so a
   * chain of them is one step to the final page, with that page's title. */
  redirectMs: 2_000,
  /** The longest a step waits for a save still in flight. */
  inflightCapMs: 10_000,
  /** The longest anything after a phrase's start waits for its transcript, counted from that start: a phrase longer than
   * this lets the steps taken while it is said go first. */
  speechCapMs: 15_000,
} as const;

export type StepTiming = { [key in keyof typeof STEP_TIMING]: number };

/** A finished network call that passed the screens (screen.ts), by when it ran. */
export type StepCall = {
  tabId: number;
  startedAt: number;
  /** When its response began to arrive; absent when only the end is known. */
  respondedAt?: number;
  endedAt: number;
  method: string;
  url: string;
  /** A request of the top frame's own document (debugger only): a form the page posted as a page load. */
  document?: true;
  /** A write's masked exchange, read through the debugger or the page hook: absent for a read, which can only lead to a
   * save, never be one. */
  exchange?: {
    url: string;
    status: number | null;
    body: JsonValue;
    response: JsonValue;
    /** Its body held what the person typed into a sensitive field in the tab, which the masking redacted. */
    typed?: true;
  };
};

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** The first word of a path segment or an operation that says it saves something. */
const WRITE_WORDS = new Set(
  [
    ["create", "creates", "created"],
    ["update", "updates", "updated"],
    ["save", "saves", "saved"],
    ["delete", "deletes", "deleted"],
    ["send", "sends", "sent"],
    ["submit", "submits", "submitted"],
    ["mark", "marks", "marked"],
    ["archive", "archives", "archived"],
    ["assign", "assigns", "assigned"],
    // A one-time code checked, a phone or an address confirmed, a backup code or a voucher redeemed.
    ["verify", "verifies", "verified"],
    ["confirm", "confirms", "confirmed"],
    ["redeem", "redeems", "redeemed"],
  ].flat(),
);
/** A value too short to tell anything apart (a digit, "ok") is never matched in a body. */
const MIN_TYPED = 3;
/** The text of what was clicked counts only when it is long enough to be what was said (a chosen suggestion), never a
 * button's "Save". */
const MIN_CHOSEN = 12;
const MAX_VALUES = 20;
/** The steps that send what was entered: a click, a submit, an Enter. */
const ACTION_STEPS = new Set(["click", "submit", "key"]);
/** An edit this soon after such a step is its echo (the field's change as Enter or a click on Send blurs it): the save
 * stays the action's. */
const ECHO_MS = 50;
/** A form's submit this soon after a click is the click's own doing: a submit button submits its form as the click's
 * default action, in the same task. */
const SUBMITTED_MS = ECHO_MS;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The first word of a name, lower case: `sendMessage` -> `send`, `MARKED_AS_READ` -> `marked`; for a dotted RPC name only
 * its last part counts (`com.example.rpc.BreezeEngineService` -> `breeze`), never a package name such as `updates`. */
function firstWord(name: string): string | undefined {
  const last = name.split(".").pop() ?? name;
  return last
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)[0]
    ?.toLowerCase();
}

/** Words that mark a write as the page keeping itself alive or reporting on itself, never a save: presence,
 * heartbeats, pings, typing indicators, session refreshes, telemetry, tracking and logs. */
const CHATTER_WORDS = new Set([
  "presence",
  "heartbeat",
  "heartbeats",
  "ping",
  "pings",
  "keepalive",
  "typing",
  "telemetry",
  "track",
  "tracking",
  "log",
  "logs",
  "logging",
]);

/** Every word of a name, lower case: `updateBreezePresence` -> update, breeze, presence; `keep-alive` -> keepalive. */
function words(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/keep[\s_-]*alive/g, "keepalive")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Whether a write's path or operation says it is the page's own chatter (updateBreezePresence, /heartbeat,
 * /session/refresh, trackEvent, /logs/batch) rather than something the person saved. A read receipt sent as a POST
 * call (markConversationRead, markAsSeen) is the page noting what it showed; one sent as a PUT or PATCH on the thing
 * itself (`/notifications/9/action/MARKED_AS_READ`) is the person's own choice, as dismissing a banner is. */
export function isChatter(
  path: string,
  operation?: string,
  method = "POST",
): boolean {
  const all = [...words(path), ...(operation ? words(operation) : [])];
  if (all.some((word) => CHATTER_WORDS.has(word))) return true;
  if (all.includes("session") && all.includes("refresh")) return true;
  return (
    method.toUpperCase() === "POST" &&
    all.includes("mark") &&
    all.some((word) => word === "read" || word === "seen" || word === "viewed")
  );
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8,}(?:-[0-9a-f]{4,})*)$/i;

/** Whether an operation name, or the last two segments of a path that are not ids, say they save something:
 * `/api/notes/create`, `/rpc.MessageService/sendMessage`, `/contacts/42/archive`. */
function soundsLikeWrite(text: string | undefined, isPath = false): boolean {
  if (text === undefined) return false;
  const names = isPath
    ? text
        .split("/")
        .filter((segment) => segment && !ID_SEGMENT.test(segment))
        .slice(-2)
    : [text];
  return names.some((name) => {
    const word = firstWord(name);
    return word !== undefined && WRITE_WORDS.has(word);
  });
}

/** What a GraphQL body is: a mutation, a query, or not GraphQL at all. */
function graphql(
  url: string,
  text: string | undefined,
): {
  kind: "mutation" | "query" | null;
  operation?: string;
} {
  if (text === undefined) return { kind: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: null };
  }
  const operations = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    isObject,
  );
  const looksLikeGraphql =
    /graphql/i.test(url) ||
    operations.some(
      (op) =>
        typeof op.query === "string" ||
        (isObject(op.extensions) && "persistedQuery" in op.extensions),
    );
  if (!looksLikeGraphql || operations.length === 0) return { kind: null };
  const names = operations
    .map((op) => op.operationName)
    .filter((name): name is string => typeof name === "string");
  const queries = operations
    .map((op) => op.query)
    .filter((query): query is string => typeof query === "string");
  if (queries.length === 0)
    // A persisted query sends only its name.
    return {
      kind: names.some((name) => soundsLikeWrite(name)) ? "mutation" : "query",
      operation: names[0],
    };
  const mutation = queries.some((query) =>
    /(?:^|\})\s*mutation\b/.test(query.replace(/#[^\n]*/g, "").trimStart()),
  );
  // An unnamed operation is known by its first field: `mutation { updatePresence(...) }`.
  const field = queries[0]?.match(/^[^{]*\{\s*(\w+)/)?.[1];
  return {
    kind: mutation ? "mutation" : "query",
    operation: [names[0], field].filter(Boolean).join(" ") || undefined,
  };
}

const bodyText = (body: JsonValue | undefined): string | undefined =>
  isObject(body) && typeof body.text === "string" ? body.text : undefined;

/** True when the masked body holds one of the values, as typed, JSON-escaped or form-encoded. */
export function carriesValues(
  text: string | undefined,
  values: readonly string[],
): boolean {
  if (!text) return false;
  return values.some((value) => {
    const forms = [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      encodeURIComponent(value).replace(/%20/g, "+"),
    ];
    return forms.some((form) => text.includes(form));
  });
}

/** Whether a call the step owns is its save, and whether it carries the person's values: as typed, or, for what they
 * typed into a sensitive field, by the capture's mark. */
export function saveQuality(
  call: StepCall,
  values: readonly string[],
): { save: boolean; carries: boolean } {
  const method = call.method.toUpperCase();
  if (!WRITE_METHODS.has(method) || !call.exchange)
    return { save: false, carries: false };
  const text = bodyText(call.exchange.body);
  const carries = call.exchange.typed === true || carriesValues(text, values);
  const gql = graphql(call.url, text);
  let path = call.url;
  try {
    path = new URL(call.url).pathname;
  } catch {
    // Not a URL: its text is its path.
  }
  // A form posted as a page load (a classic sign-in or a reset-password form) is the person sending that form, whatever
  // its address says: no page keeps itself alive or reports on itself by navigating.
  if (call.document) return { save: true, carries };
  if (isChatter(path, gql.operation, method)) return { save: false, carries };
  if (gql.kind === "query") return { save: false, carries };
  if (gql.kind === "mutation") return { save: true, carries };
  if (method !== "POST") return { save: true, carries };
  return { save: carries || soundsLikeWrite(path, true), carries };
}

type Pending = {
  tabId: number;
  at: number;
  event: CapturedEvent;
  /** Which held item it is, kept in a snapshot: it leaves with this key, so the document stores it once however often a
   * restart sends it (a quit can come after it left and before the snapshot without it was written). */
  key?: string;
  /** Not a step: an event placed among the steps by its time, sent as it is once every step before it left. */
  placed?: true;
  /** A placed transcript: the phrase being spoken holds back what came after its start, never its own words. */
  speech?: true;
  /** A step the person took in the page (it can own calls); a page change, or an edit that echoes the action just
   * before it, only follows from one. */
  owner: boolean;
  /** Owners: calls starting from here on belong to a later step. */
  closeAt: number;
  /** What the person typed in the tab before this step, and what this step chose. */
  values: string[];
  /** A page change, or a step from an iframe: the page it belongs to, once known. */
  page?: { url: string; title?: string };
  waitingForPage: boolean;
  timer?: unknown;
  /** A page change: when its page's title is looked up. */
  pageTimer?: unknown;
  /** A page change: when its chain's last page change came, and which lookup of its page counts. */
  lastHop?: number;
  lookup?: number;
  /** A page change the person has not acted on, on a site they have not left: held, with all that came after it, until
   * the visit ends. */
  visiting?: true;
};

/** One held item as a snapshot keeps it: its timers are set again when it is restored. `open` marks its tab's page
 * change that a redirect may still join. */
export type HeldStep = Omit<Pending, "timer" | "pageTimer" | "lookup"> & {
  open?: true;
};

/** Everything an assembler holds, as JSON: the held steps and placed events in their order, the calls a held step may
 * still own, what the person typed in each tab, and the phrase being spoken. Saves in flight are not kept: the capture
 * that would report their end went with the service worker that saw them start. */
export type StepSnapshot = {
  queue: HeldStep[];
  calls: StepCall[];
  typed: [number, string[]][];
  speech: { since: number; until: number } | null;
};

const stepValue = (event: CapturedEvent): Record<string, unknown> =>
  isObject(event.value) ? event.value : {};

/** Chrome's transitions (webNavigation TransitionType) that are the person going somewhere from the browser itself: an
 * address typed, a bookmark, a suggestion picked, a start page. */
const PERSON_TRANSITIONS = new Set([
  "typed",
  "auto_bookmark",
  "generated",
  "keyword",
  "keyword_generated",
  "start_page",
]);

/** Whether a page change is the person's own: a reload, a step back or forward, or a place they went from the browser. */
function byPerson(value: Record<string, unknown>): boolean {
  const kind = value.navigationType;
  if (kind === "reload" || kind === "traverse") return true;
  if (
    typeof value.transitionType === "string" &&
    PERSON_TRANSITIONS.has(value.transitionType)
  )
    return true;
  return (
    Array.isArray(value.transitionQualifiers) &&
    value.transitionQualifiers.includes("from_address_bar")
  );
}

/** A typed value of an edit step, as masked: a redacted one is never matched. */
function typedValue(event: CapturedEvent): string | undefined {
  if (event.name !== "input") return undefined;
  const target = stepValue(event).target;
  const value = isObject(target) ? target.value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < MIN_TYPED || trimmed.includes(REDACTED))
    return undefined;
  return trimmed;
}

/** The text of what the step chose, when long enough to be what the person said (a suggestion clicked). */
function chosenText(event: CapturedEvent): string | undefined {
  if (event.name !== "click") return undefined;
  const target = stepValue(event).target;
  const name = isObject(target) ? (target.name ?? target.text) : undefined;
  if (typeof name !== "string") return undefined;
  const trimmed = name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!:]+$/, "");
  if (trimmed.length < MIN_CHOSEN || trimmed.length > 300) return undefined;
  if (trimmed.includes(REDACTED)) return undefined;
  return trimmed;
}

export type StepAssembler = ReturnType<typeof createStepAssembler>;

export function createStepAssembler(options: {
  /** An item as it leaves, with its key (`Pending.key`). */
  emit(event: CapturedEvent, key?: string): void;
  /** A step of the person's as it leaves, with what was seen while it was held: `joins` says whether something the page
   * started at a time is the step's doing, by its join (a click's run, the agent events' `settleClick`). */
  settle?(
    tabId: number,
    event: CapturedEvent,
    joins: (at: number) => boolean,
  ): CapturedEvent;
  /** Whether a step still waits for something the page may yet start in its join (a click's run, the agent events'
   * `awaitsRun`): it is held until that comes or its join closes. */
  awaits?(
    tabId: number,
    event: CapturedEvent,
    joins: (at: number) => boolean,
  ): boolean;
  /** The tab's top page (masked), for a page change and a step from an iframe. */
  pageOf?(tabId: number): Promise<{ url: string; title?: string } | null>;
  /** A new held item's key: a random UUID unless a test passes its own. */
  newKey?(): string;
  /** Something it holds changed (a step came or left, a call arrived, the phrase being spoken changed): `snapshot`
   * would now read differently. */
  onChange?(): void;
  /** Items are about to leave, and `snapshot` still holds them: what is kept beside the steps can be written first. */
  leaving?(): void;
  now?: () => number;
  timers?: Timers;
  tuning?: Partial<StepTiming>;
}) {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const tune: StepTiming = { ...STEP_TIMING, ...options.tuning };
  const newKey = options.newKey ?? (() => crypto.randomUUID());
  const queue: Pending[] = [];
  const calls = new Map<number, StepCall[]>();
  const typed = new Map<number, string[]>();
  const inflight = new Map<string, { tabId: number; startedAt: number }>();
  /** Each tab's page change still held with no step of the person's after it: a redirect joins it. */
  const openChange = new Map<number, Pending>();
  /** The phrase being spoken: from its start until its transcript is placed, or `until` at the latest. */
  let speech: { since: number; until: number } | null = null;
  let speechTimer: unknown;
  let ended = false;
  const changed = () => options.onChange?.();

  /** Whether the phrase being spoken holds the item back: it came after the phrase began (its own transcript never). */
  const heldBySpeech = (step: Pending, at: number): boolean =>
    speech !== null &&
    !step.speech &&
    step.at >= speech.since &&
    at < speech.until;

  const lastOwner = (tabId: number): Pending | undefined => {
    for (let i = queue.length - 1; i >= 0; i--) {
      const step = queue[i];
      if (step?.owner && step.tabId === tabId) return step;
    }
    return undefined;
  };

  function readyAt(step: Pending): number {
    return step.closeAt + tune.settleMs;
  }

  /** How long after a step the page may still start what the step did: a Send whose page makes a call of its own before
   * it runs the message (OpenBot's composer routes it first: 2.06 s in the end-to-end run, its run 2.18 s after the
   * click). No longer than the steps already hold a step nothing follows (`horizonMs` + `settleMs`), so waiting for it
   * never holds the recording longer than that. */
  const joinMs = tune.horizonMs + tune.settleMs;

  /** The person's steps in the step's tab after it, in order; the step may have left the queue already. */
  const followers = (step: Pending): Pending[] => {
    const index = queue.indexOf(step);
    return (index === -1 ? queue : queue.slice(index + 1)).filter(
      (other) => other.owner && other.tabId === step.tabId,
    );
  };

  /** When the step's join closes: `joinMs` after it, or as the person's next step in its tab begins (less the lead a
   * call may have on a step), a click's form submit being the click's own doing. */
  function joinEnd(step: Pending): number {
    const later = followers(step);
    const next = submitOf(step) ? later[1] : later[0];
    return Math.min(
      step.at + joinMs,
      next === undefined ? Number.POSITIVE_INFINITY : next.at - tune.leadMs,
    );
  }

  /** Whether something the page started at a time falls in the step's join: from the step until its join closes. */
  const joinsOf = (step: Pending): ((at: number) => boolean) => {
    const end = joinEnd(step);
    return (at) => at >= step.at && at < end;
  };

  /** Whether the step is still held for something the page may yet start in its join, which has not come. */
  const awaiting = (step: Pending, at: number): boolean =>
    options.awaits !== undefined &&
    at < joinEnd(step) &&
    options.awaits(step.tabId, step.event, joinsOf(step));

  function isReady(step: Pending, at: number): boolean {
    if (step.placed) return true;
    // A page change is ready once its page was looked up, `redirectMs` after its chain's last page change, and the
    // person's visit to it is over.
    if (!step.owner) return !step.waitingForPage && !step.visiting;
    if (step.waitingForPage) return false;
    if (at < readyAt(step)) return false;
    if (at >= step.closeAt + tune.inflightCapMs) return true;
    // A save that started inside the step's span and has not finished yet holds the step.
    for (const flight of inflight.values())
      if (
        flight.tabId === step.tabId &&
        flight.startedAt >= step.at - tune.leadMs &&
        flight.startedAt < step.closeAt
      )
        return false;
    return !awaiting(step, at);
  }

  function schedule(step: Pending): void {
    if (step.timer !== undefined) timers.clear(step.timer);
    const wait = Math.max(0, readyAt(step) - now());
    step.timer = timers.set(pump, wait);
  }

  /** Whether something that started at `at` falls in the step's span: from `leadMs` before it until the next step. */
  const inSpan = (step: Pending, at: number): boolean =>
    at >= step.at - tune.leadMs && at < step.closeAt;

  /** The calls the step owns, in the order they started, and the save among them. */
  function saveOf(step: Pending): StepCall | undefined {
    const mine = (calls.get(step.tabId) ?? [])
      .filter((call) => inSpan(step, call.startedAt))
      .sort((a, b) => a.startedAt - b.startedAt);
    const links: { respondedAt: number; endedAt: number; depth: number }[] = [];
    let first: StepCall | undefined;
    let carrying: StepCall | undefined;
    for (const call of mine) {
      const offset = call.startedAt - step.at;
      let depth: number | null = offset <= tune.windowMs ? 0 : null;
      if (depth === null && offset <= tune.horizonMs)
        for (const link of links)
          if (
            link.depth < tune.maxDepth &&
            call.startedAt >= link.respondedAt &&
            call.startedAt <= link.endedAt + tune.chainGapMs
          ) {
            depth =
              depth === null ? link.depth + 1 : Math.min(depth, link.depth + 1);
          }
      if (depth === null) continue;
      links.push({
        respondedAt: call.respondedAt ?? call.endedAt,
        endedAt: call.endedAt,
        depth,
      });
      const quality = saveQuality(call, step.values);
      if (!quality.save) continue;
      first ??= call;
      if (quality.carries) carrying ??= call;
    }
    return carrying ?? first;
  }

  /** The submit a click made of its form, which follows it at once and so closes its span. */
  function submitOf(step: Pending): Pending | undefined {
    if (step.event.name !== "click") return undefined;
    const [next] = followers(step);
    return next?.event.name === "submit" &&
      next.at >= step.at &&
      next.at - step.at <= SUBMITTED_MS
      ? next
      : undefined;
  }

  /** The step's event as it is sent: its page filled in, its save attached, cut to fit one Intelligence event. */
  function finish(step: Pending): CapturedEvent {
    if (step.placed) return step.event;
    // A click's form submit is the click's doing, so the click's join runs past it (for `settle` only; a save in the
    // submit's span stays the submit's).
    const event =
      step.owner && options.settle
        ? options.settle(step.tabId, step.event, joinsOf(step))
        : step.event;
    const value: Record<string, unknown> = { ...stepValue(event) };
    if (step.page && !isObject(value.page)) value.page = step.page;
    if (step.owner) {
      const save = saveOf(step);
      if (save?.exchange) {
        if (carriesValues(bodyText(save.exchange.body), step.values))
          typed.delete(step.tabId);
        const request = {
          method: save.method.toUpperCase(),
          url: save.exchange.url,
          status: save.exchange.status,
          body: save.exchange.body,
          response: save.exchange.response,
        };
        value.request = fitRequest(
          { ...event, value: value as JsonValue },
          request,
        );
      }
    }
    return trimEvent(
      { ...event, value: value as JsonValue },
      EVENT_BUDGET_BYTES,
    ).event;
  }

  function pump(): void {
    if (ended) return;
    const at = now();
    let announced = false;
    while (queue.length > 0) {
      const head = queue[0];
      if (!head) break;
      // The phrase's transcript, or the end of its hold (its own timer), pumps again.
      if (heldBySpeech(head, at)) break;
      if (!isReady(head, at)) {
        if (head.owner && !head.waitingForPage) {
          if (head.timer !== undefined) timers.clear(head.timer);
          // A timer may fire a moment early: it is set again for the rest. Past its time, what it awaits in its join holds
          // it until that comes or the join closes, and a save in flight until that save ends or its cap is reached.
          head.timer = timers.set(
            pump,
            at < readyAt(head)
              ? readyAt(head) - at
              : awaiting(head, at)
                ? joinEnd(head) - at
                : Math.max(0, head.closeAt + tune.inflightCapMs - at),
          );
        }
        break;
      }
      if (!announced) {
        announced = true;
        options.leaving?.();
      }
      queue.shift();
      if (head.timer !== undefined) timers.clear(head.timer);
      if (openChange.get(head.tabId) === head) openChange.delete(head.tabId);
      options.emit(finish(head), head.key);
    }
    prune(at);
    changed();
  }

  /** Ends the visits `ends` picks: what each held goes out in its place, once the rest of it is ready. */
  function endVisits(ends: (held: Pending) => boolean): void {
    let any = false;
    for (const held of queue)
      if (held.visiting && ends(held)) {
        delete held.visiting;
        any = true;
      }
    if (any) pump();
  }

  /** The site a held page change went to. */
  const siteOfChange = (held: Pending): string | null => {
    const to = stepValue(held.event).to;
    return siteOf(typeof to === "string" ? to : null);
  };

  function prune(at: number): void {
    // Only a step of the person's owns calls: a visit held for minutes keeps none of the calls made meanwhile.
    const oldest = Math.min(
      at - 2 * 60_000,
      ...queue
        .filter((step) => step.owner)
        .map((step) => step.at - tune.leadMs),
    );
    for (const [tabId, list] of calls) {
      const kept = list.filter((call) => call.startedAt >= oldest);
      if (kept.length === 0) calls.delete(tabId);
      else calls.set(tabId, kept);
    }
  }

  /** Looks up the tab's page for the step; it waits for the answer, or for `inflightCapMs` at most. A page change
   * that a later redirect joined meanwhile looks again, and the earlier answer does not count. */
  function fetchPage(step: Pending): void {
    if (!options.pageOf) {
      step.waitingForPage = false;
      pump();
      return;
    }
    step.waitingForPage = true;
    const lookup = (step.lookup ?? 0) + 1;
    step.lookup = lookup;
    let done = false;
    const finish = () => {
      if (done || step.lookup !== lookup) return;
      done = true;
      timers.clear(cap);
      step.waitingForPage = false;
      pump();
    };
    const cap = timers.set(finish, tune.inflightCapMs);
    options.pageOf(step.tabId).then((page) => {
      if (page && !done && step.lookup === lookup) step.page = page;
      finish();
    }, finish);
  }

  /** Puts an event that is not a step among the held ones by its time, after every one from before it. */
  function insert(tabId: number, event: CapturedEvent, speaking: boolean) {
    if (ended) return;
    const at = event.timestamp;
    let index = queue.length;
    while (index > 0 && (queue[index - 1]?.at ?? 0) > at) index--;
    queue.splice(index, 0, {
      tabId,
      at,
      event,
      key: newKey(),
      placed: true,
      ...(speaking ? { speech: true as const } : {}),
      owner: false,
      closeAt: at,
      values: [],
      waitingForPage: false,
    });
    pump();
  }

  return {
    /** A step the person took in the page (click, edit, choice, submit, Enter): `fromFrame` when it came from an
     * iframe, whose page is the tab's. */
    step(tabId: number, event: CapturedEvent, fromFrame = false): void {
      if (ended) return;
      // A page change after this one is the person's doing, never a redirect of the one before.
      openChange.delete(tabId);
      // The person acted: the page they arrived on goes out ahead of their first step there, and a page in another tab
      // is one they have left, since a person acts only on the page in front of them.
      endVisits(() => true);
      const at = event.timestamp;
      const previous = lastOwner(tabId);
      const echo =
        event.name === "input" &&
        previous !== undefined &&
        ACTION_STEPS.has(previous.event.name) &&
        at >= previous.at &&
        at - previous.at <= ECHO_MS;
      if (!echo && previous && at - tune.leadMs < previous.closeAt) {
        previous.closeAt = Math.max(previous.at, at - tune.leadMs);
        schedule(previous);
      }
      const own = typedValue(event);
      const chosen = chosenText(event);
      const values = [...(typed.get(tabId) ?? [])];
      if (own) values.push(own);
      if (chosen) values.push(chosen);
      if (own)
        typed.set(tabId, [...(typed.get(tabId) ?? []), own].slice(-MAX_VALUES));
      const step: Pending = {
        tabId,
        at,
        event,
        key: newKey(),
        owner: !echo,
        closeAt: at + tune.horizonMs,
        values,
        waitingForPage: false,
      };
      queue.push(step);
      if (fromFrame) fetchPage(step);
      if (step.owner) schedule(step);
      // The person's next step closes the join a step before it may still be held for.
      pump();
      changed();
    },

    /** A page change in the tab's top frame: sent in its place among the steps, once its page has a title. */
    navigation(tabId: number, event: CapturedEvent): void {
      if (ended) return;
      const open = openChange.get(tabId);
      const since = open ? event.timestamp - (open.lastHop ?? open.at) : -1;
      // A reload, a step back or forward, or an address the person typed or picked in the browser is the person's; a
      // push or a replace this soon after the last is the page's.
      if (
        open &&
        queue.includes(open) &&
        !byPerson(stepValue(event)) &&
        since >= 0 &&
        since <= tune.redirectMs
      ) {
        // A redirect: the held page change now ends where this one does, and still begins where and how it began.
        const first = stepValue(open.event);
        const { transitionType, transitionQualifiers, ...last } =
          stepValue(event);
        open.event = {
          ...open.event,
          value: {
            ...last,
            from: first.from ?? "",
            navigationType: first.navigationType ?? "push",
            ...(first.transitionType !== undefined
              ? { transitionType: first.transitionType }
              : {}),
            ...(first.transitionQualifiers !== undefined
              ? { transitionQualifiers: first.transitionQualifiers }
              : {}),
          } as unknown as JsonValue,
        };
        open.lastHop = event.timestamp;
        open.page = undefined;
        open.waitingForPage = true;
        open.lookup = (open.lookup ?? 0) + 1;
        if (open.pageTimer !== undefined) timers.clear(open.pageTimer);
        open.pageTimer = timers.set(() => fetchPage(open), tune.redirectMs);
        changed();
        return;
      }
      const step: Pending = {
        tabId,
        at: event.timestamp,
        event,
        key: newKey(),
        owner: false,
        closeAt: event.timestamp,
        values: [],
        waitingForPage: true,
        lastHop: event.timestamp,
        visiting: true,
      };
      // A page on the site the person is visiting in the tab is more of the same visit, held with it; one on another
      // site ends that visit, since they left its site.
      const site = siteOfChange(step);
      endVisits((held) => held.tabId === tabId && siteOfChange(held) !== site);
      queue.push(step);
      openChange.set(tabId, step);
      step.pageTimer = timers.set(() => fetchPage(step), tune.redirectMs);
      changed();
    },

    /** The person moved to this tab (they switched to it, or brought its window to the front): a visit in any other tab
     * is over. */
    entered(tabId: number): void {
      if (ended) return;
      endVisits((held) => held.tabId !== tabId);
    },

    /** The tab closed: its visit is over. */
    left(tabId: number): void {
      if (ended) return;
      endVisits((held) => held.tabId === tabId);
    },

    /** An event that is not a step (the agent's side): it leaves after every step held from before its time and
     * before every held step from after it. With nothing held from before it, it leaves at once. */
    place(tabId: number, event: CapturedEvent): void {
      insert(tabId, event, false);
    },

    /** A phrase's transcript, stamped with the phrase's start: placed as `place` places an event, and the phrase being
     * spoken never holds it back. */
    transcript(tabId: number, event: CapturedEvent): void {
      insert(tabId, event, true);
    },

    /** A phrase began at `since` (null: none is being spoken): nothing from then on leaves until its transcript is
     * placed and the hold moves on, or `speechCapMs` after `since`. */
    hold(since: number | null): void {
      if (ended) return;
      if (speechTimer !== undefined) timers.clear(speechTimer);
      speechTimer = undefined;
      speech =
        since === null ? null : { since, until: since + tune.speechCapMs };
      if (speech)
        speechTimer = timers.set(pump, Math.max(0, speech.until - now()));
      pump();
    },

    /** What it holds now, as JSON, or null when it holds nothing that would be lost. */
    snapshot(): StepSnapshot | null {
      const values = [...typed].filter(([, list]) => list.length > 0);
      if (queue.length === 0 && values.length === 0 && speech === null)
        return null;
      // Only the calls a held step may still own: from `leadMs` before the earliest one on.
      let from = Number.POSITIVE_INFINITY;
      for (const step of queue)
        if (step.owner) from = Math.min(from, step.at - tune.leadMs);
      return {
        queue: queue.map(
          ({ timer: _t, pageTimer: _p, lookup: _l, ...held }, index) =>
            openChange.get(held.tabId) === queue[index]
              ? { ...held, open: true }
              : held,
        ),
        calls: [...calls.values()]
          .flat()
          .filter((call) => call.startedAt >= from),
        typed: values,
        speech,
      };
    },

    /** Takes up what another assembler held (its `snapshot`), on a fresh one, and goes on under the same rules: each
     * step waits out what is left of its window, a page change looks its page up again, and the phrase's hold runs to
     * its end. */
    restore(snapshot: StepSnapshot): void {
      if (ended) return;
      const restored: Pending[] = [];
      for (const { open, ...held } of snapshot.queue) {
        const step: Pending = { ...held };
        restored.push(step);
        if (open) openChange.set(step.tabId, step);
      }
      queue.push(...restored);
      for (const call of snapshot.calls) {
        const list = calls.get(call.tabId) ?? [];
        list.push(call);
        calls.set(call.tabId, list);
      }
      for (const [tabId, values] of snapshot.typed) typed.set(tabId, values);
      if (snapshot.speech) {
        speech = snapshot.speech;
        speechTimer = timers.set(
          pump,
          Math.max(0, snapshot.speech.until - now()),
        );
      }
      for (const step of restored) {
        if (step.placed) continue;
        if (step.waitingForPage) {
          if (step.lastHop !== undefined) {
            // A page change: its page is looked up `redirectMs` after its chain's last hop, as before.
            const wait = Math.max(0, step.lastHop + tune.redirectMs - now());
            step.pageTimer = timers.set(() => fetchPage(step), wait);
          } else fetchPage(step);
        }
        if (step.owner) schedule(step);
      }
      pump();
    },

    /** A finished call that passed the screens. */
    call(call: StepCall): void {
      if (ended) return;
      const list = calls.get(call.tabId) ?? [];
      list.push(call);
      calls.set(call.tabId, list);
      pump();
    },

    /** A write began (debugger only: the page hook reports a call once it is answered): a step it may be the save of
     * waits for it. */
    writeStarted(id: string, tabId: number, startedAt: number): void {
      if (ended) return;
      inflight.set(id, { tabId, startedAt });
    },
    writeEnded(id: string): void {
      if (!inflight.delete(id) || ended) return;
      pump();
    },

    /** Sends every step held, with what it owns so far (the recording stops or starts over). */
    flush(): void {
      if (ended) return;
      if (queue.length > 0) options.leaving?.();
      while (queue.length > 0) {
        const step = queue.shift();
        if (!step) break;
        if (step.timer !== undefined) timers.clear(step.timer);
        if (step.pageTimer !== undefined) timers.clear(step.pageTimer);
        options.emit(finish(step), step.key);
      }
      calls.clear();
      typed.clear();
      inflight.clear();
      openChange.clear();
      changed();
    },

    /** The person kept the tab's site out of the recording: everything still held from the tab (its steps and page
     * changes, and the agent's events placed for it) is dropped and never sent, with the calls and typing it kept. A
     * phrase's transcript stays: it is the person's narration, placed in the recording's first tab whichever tab they
     * spoke over. */
    dropTab(tabId: number): void {
      if (ended) return;
      for (let index = queue.length - 1; index >= 0; index--) {
        const held = queue[index];
        if (held?.tabId !== tabId || held.speech) continue;
        if (held.timer !== undefined) timers.clear(held.timer);
        if (held.pageTimer !== undefined) timers.clear(held.pageTimer);
        queue.splice(index, 1);
      }
      this.forgetTab(tabId);
      changed();
    },

    forgetTab(tabId: number): void {
      openChange.delete(tabId);
      calls.delete(tabId);
      typed.delete(tabId);
      for (const [id, flight] of inflight)
        if (flight.tabId === tabId) inflight.delete(id);
      pump();
    },

    /** Nothing more is sent: what was held is dropped. */
    clear(): void {
      ended = true;
      for (const step of queue) {
        if (step.timer !== undefined) timers.clear(step.timer);
        if (step.pageTimer !== undefined) timers.clear(step.pageTimer);
      }
      if (speechTimer !== undefined) timers.clear(speechTimer);
      speechTimer = undefined;
      speech = null;
      queue.length = 0;
      calls.clear();
      typed.clear();
      inflight.clear();
      openChange.clear();
      changed();
    },
  };
}

/** The save as the step carries it: its bodies cut so the whole step fits one Intelligence event. */
function fitRequest(
  step: CapturedEvent,
  request: {
    method: string;
    url: string;
    status: number | null;
    body: JsonValue;
    response: JsonValue;
  },
): JsonValue {
  const without = JSON.stringify(step).length;
  // The network event's own shape, so trimEvent cuts both bodies as it cuts a network event's.
  const exchange: CapturedEvent = {
    type: "CUSTOM",
    name: "network",
    timestamp: step.timestamp,
    value: {
      request: { body: request.body },
      response: { body: request.response },
    },
  };
  const budget = Math.max(512, EVENT_BUDGET_BYTES - without - 512);
  const cut = trimEvent(exchange, budget).event.value as {
    request?: { body?: JsonValue };
    response?: { body?: JsonValue };
  };
  return {
    method: request.method,
    url: request.url,
    status: request.status,
    body: cut.request?.body ?? { status: "unavailable", reason: "too-large" },
    response: cut.response?.body ?? {
      status: "unavailable",
      reason: "too-large",
    },
  } as JsonValue;
}
