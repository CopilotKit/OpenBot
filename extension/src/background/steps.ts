// A recording is the person's steps: each click, edit, choice, submit, Enter and top-frame page change, in order, so an
// agent can be trained to do the same clicks and enter the same data. A step that saved something carries the one
// request it sent to save it, so the agent also learns what the save looks like; the page's other traffic is never
// recorded.
//
// A step is held until its window closes (or the next step in its tab starts) and every call it may own has arrived,
// then sent with its request in place; steps leave in the order they came.
//
// Which calls a step owns is drawn in time, per tab, since Chrome gives no reliable link from a call to the input that
// caused it: a call is the latest step's when it starts no earlier than `leadMs` before that step (a handler can run on
// pointerdown, before the click), and either within `windowMs` of it or within `chainGapMs` of the end of a call the
// step already owns (a request made from the previous one's response), at most `maxDepth` links and `horizonMs` from
// the step. Of those, the save is a write that sounds like one:
// - PUT, PATCH or DELETE;
// - a GraphQL mutation (never a query);
// - a POST whose masked body carries what the person just typed or chose, or whose path or operation is a write
//   (create, update, save, delete, send, submit, mark, archive, assign). Apps read their configuration through POSTs
//   too, and those stay out.
// When several qualify, the one carrying the person's values wins, else the first.
import {
  type CapturedEvent,
  EVENT_BUDGET_BYTES,
  type JsonValue,
  REDACTED,
  trimEvent,
} from "@openbot/shared/recorder-masking";

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
  /** How long a page change waits before it is sent, so its page has a title. */
  navigationMs: 1_000,
  /** The longest a step waits for a save still in flight. */
  inflightCapMs: 10_000,
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
  /** A write's masked exchange, read through the debugger or the page hook: absent for a read, which can only lead to a
   * save, never be one. */
  exchange?: {
    url: string;
    status: number | null;
    body: JsonValue;
    response: JsonValue;
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
  return { kind: mutation ? "mutation" : "query", operation: names[0] };
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

/** Whether a call the step owns is its save, and whether it carries the person's values. */
export function saveQuality(
  call: StepCall,
  values: readonly string[],
): { save: boolean; carries: boolean } {
  const method = call.method.toUpperCase();
  if (!WRITE_METHODS.has(method) || !call.exchange)
    return { save: false, carries: false };
  const text = bodyText(call.exchange.body);
  const carries = carriesValues(text, values);
  const gql = graphql(call.url, text);
  if (gql.kind === "query") return { save: false, carries };
  if (gql.kind === "mutation") return { save: true, carries };
  if (method !== "POST") return { save: true, carries };
  let path = call.url;
  try {
    path = new URL(call.url).pathname;
  } catch {
    // Not a URL: its text is its path.
  }
  return { save: carries || soundsLikeWrite(path, true), carries };
}

type Pending = {
  tabId: number;
  at: number;
  event: CapturedEvent;
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
};

const stepValue = (event: CapturedEvent): Record<string, unknown> =>
  isObject(event.value) ? event.value : {};

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
  emit(event: CapturedEvent): void;
  /** The tab's top page (masked), for a page change and a step from an iframe. */
  pageOf?(tabId: number): Promise<{ url: string; title?: string } | null>;
  now?: () => number;
  timers?: Timers;
  tuning?: Partial<StepTiming>;
}) {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  const tune: StepTiming = { ...STEP_TIMING, ...options.tuning };
  const queue: Pending[] = [];
  const calls = new Map<number, StepCall[]>();
  const typed = new Map<number, string[]>();
  const inflight = new Map<string, { tabId: number; startedAt: number }>();
  let ended = false;

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

  function isReady(step: Pending, at: number): boolean {
    // A page change is ready once its page was looked up, `navigationMs` after it.
    if (!step.owner) return !step.waitingForPage;
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
    return true;
  }

  function schedule(step: Pending): void {
    if (step.timer !== undefined) timers.clear(step.timer);
    const wait = Math.max(0, readyAt(step) - now());
    step.timer = timers.set(pump, wait);
  }

  /** The calls the step owns, in the order they started, and the save among them. */
  function saveOf(step: Pending): StepCall | undefined {
    const mine = (calls.get(step.tabId) ?? [])
      .filter(
        (call) =>
          call.startedAt >= step.at - tune.leadMs &&
          call.startedAt < step.closeAt,
      )
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

  /** The step's event as it is sent: its page filled in, its save attached, cut to fit one Intelligence event. */
  function finish(step: Pending): CapturedEvent {
    const value: Record<string, unknown> = { ...stepValue(step.event) };
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
          { ...step.event, value: value as JsonValue },
          request,
        );
      }
    }
    return trimEvent(
      { ...step.event, value: value as JsonValue },
      EVENT_BUDGET_BYTES,
    ).event;
  }

  function pump(): void {
    if (ended) return;
    const at = now();
    while (queue.length > 0) {
      const head = queue[0];
      if (!head) break;
      if (!isReady(head, at)) {
        if (head.owner && !head.waitingForPage) {
          if (head.timer !== undefined) timers.clear(head.timer);
          // A timer may fire a moment early: it is set again for the rest. Past its time, a save in flight holds it
          // until that save ends or its cap is reached.
          head.timer = timers.set(
            pump,
            at < readyAt(head)
              ? readyAt(head) - at
              : Math.max(0, head.closeAt + tune.inflightCapMs - at),
          );
        }
        break;
      }
      queue.shift();
      if (head.timer !== undefined) timers.clear(head.timer);
      options.emit(finish(head));
    }
    prune(at);
  }

  function prune(at: number): void {
    const oldest = Math.min(
      at - 2 * 60_000,
      ...queue.map((step) => step.at - tune.leadMs),
    );
    for (const [tabId, list] of calls) {
      const kept = list.filter((call) => call.startedAt >= oldest);
      if (kept.length === 0) calls.delete(tabId);
      else calls.set(tabId, kept);
    }
  }

  /** Looks up the tab's page for the step; it waits for the answer, or for `inflightCapMs` at most. */
  function fetchPage(step: Pending): void {
    if (!options.pageOf) {
      step.waitingForPage = false;
      pump();
      return;
    }
    step.waitingForPage = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      timers.clear(cap);
      step.waitingForPage = false;
      pump();
    };
    const cap = timers.set(finish, tune.inflightCapMs);
    options.pageOf(step.tabId).then((page) => {
      if (page && !done) step.page = page;
      finish();
    }, finish);
  }

  return {
    /** A step the person took in the page (click, edit, choice, submit, Enter): `fromFrame` when it came from an
     * iframe, whose page is the tab's. */
    step(tabId: number, event: CapturedEvent, fromFrame = false): void {
      if (ended) return;
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
        owner: !echo,
        closeAt: at + tune.horizonMs,
        values,
        waitingForPage: false,
      };
      queue.push(step);
      if (fromFrame) fetchPage(step);
      if (step.owner) schedule(step);
      else pump();
    },

    /** A page change in the tab's top frame: sent in its place among the steps, once its page has a title. */
    navigation(tabId: number, event: CapturedEvent): void {
      if (ended) return;
      const step: Pending = {
        tabId,
        at: event.timestamp,
        event,
        owner: false,
        closeAt: event.timestamp,
        values: [],
        waitingForPage: true,
      };
      queue.push(step);
      step.pageTimer = timers.set(() => fetchPage(step), tune.navigationMs);
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
      while (queue.length > 0) {
        const step = queue.shift();
        if (!step) break;
        if (step.timer !== undefined) timers.clear(step.timer);
        if (step.pageTimer !== undefined) timers.clear(step.pageTimer);
        options.emit(finish(step));
      }
      calls.clear();
      typed.clear();
      inflight.clear();
    },

    forgetTab(tabId: number): void {
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
      queue.length = 0;
      calls.clear();
      typed.clear();
      inflight.clear();
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
