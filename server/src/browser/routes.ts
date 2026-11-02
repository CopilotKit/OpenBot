import { AsyncLocalStorage } from "node:async_hooks";
import {
  type BrowserApiState,
  type BrowserNarrationRequest,
  type BrowserOpenRequest,
  type BrowserOpenResponse,
  type BrowserProduct,
  type BrowserState,
  type BrowserWindow,
  browserApiPaths,
  browserComputerPaths,
  browserNarrationRequestSchema,
  browserNavigateRequestSchema,
  browserOpenRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  type LauncherState,
  type Narration,
  type RealBrowser,
  type RealBrowserOpenResponse,
  type RealBrowserRequest,
  realBrowserComputerPaths,
} from "@openbot/shared/openbot-browser";
import {
  RECORDER_ACTIVITY_STALE_MS,
  type RecorderActivity,
  type RecorderConnection,
} from "@openbot/shared/recorder-api";
import {
  RECORDER_EXTENSION_ID,
  RECORDER_STORE_IDS,
  recorderStorePage,
} from "@openbot/shared/recorder-extension";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import { type SeatAddress, seatHeaders } from "../computer/client";
import { checkComputerAddress } from "../computer/target";
import { reasonWithoutStatement } from "../db/query-failure";
import { recorderAudit, recorderConnected } from "../recorder/connected";
import type { ReportingConnection } from "../recorder/connections";
import type { RecorderExtensionDeps } from "../recorder/wiring";
import { personBrowserId, personBrowserInstallId } from "./person";

/** What the person sees their OpenBot browser called in Settings, Browsers, and what its connection's trail names. */
export const OPENBOT_BROWSER_LABEL = "OpenBot browser";

/** Where people's browsers run here: the computers carry them as they carry Bots' (browser/host.ts). */
export type BrowserComputers = {
  /**
   * Where the browsers these computers run show (`BrowserApiState.shows`), known without asking any of them: the
   * sidebar's Browser button reads it on every load, before the person's browser has ever been opened.
   */
  shows: BrowserWindow;
  /** The browser's computer, started when it must be. Throws when it cannot be reached. */
  locate(computerId: string): Promise<string>;
  /** Whether its computer is up, never starting it: the Browser page asks every few seconds, and asking must not start
   * a computer for everybody who opens OpenBot. */
  running(computerId: string): Promise<boolean>;
};

export type BrowserRouteDeps = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Absent when this OpenBot has no way to run a person's browser: the state says so and the app hides the button. */
  computers?: BrowserComputers;
  /**
   * What the person is told about where their browser runs (`BrowserApiState.note`), in one plain sentence: why there
   * are no `computers` for it here (its Bots share one computer, browser/host.ts), or, on OpenBot Desktop, why it is not
   * their own installed Chrome or Edge (`OPENBOT_BROWSER_ABSENT`). Absent when there is nothing to explain.
   */
  note?: string;
  /** The computer token, the same one every computer requires. */
  token?: string;
  /** The Recorder's connections and what goes with them (recorder/wiring.ts). */
  recorder: Pick<
    RecorderExtensionDeps,
    "connections" | "user" | "sealOrganizationSession" | "onConnected"
  >;
  /** The address the person's browser reaches this OpenBot at (browser/address.ts), from the request's Origin; null
   * when there is none the Recorder would accept. */
  openbotUrl: (requestOrigin: string | undefined) => string | null;
  auditStore?: AuditStore;
  fetchImpl?: typeof fetch;
  /** How long a call to the computer may take before OpenBot stops waiting, other than open's. A test's own, shorter;
   * otherwise {@link CALL_TIMEOUT_MS}. */
  callTimeoutMs?: number;
  /** Each route's budget (`OPEN_BUDGET_MS`, `CALL_BUDGET_MS`): a test's own, shorter. */
  budgetMs?: { open?: number; call?: number };
  /** A single-user OpenBot (`config.singleUser`, OpenBot Desktop among them): the one person is its admin, so a setup
   * failure is told to them as theirs to see to, not as something to ask an admin about. */
  singleUser?: boolean;
  /** The Recorder's ids in the browsers' stores, where a person adds it to their own browser: `RECORDER_STORE_IDS`
   * unless a test gives its own. Empty until it is published, and an empty one is never acted on. */
  storeIds?: { chrome?: string; edge?: string };
};

/** How long a Recorder's report of what it is doing stands without another: after this a browser that quit or lost its
 * network mid-recording stops showing the red dot (shared/recorder-api.ts). */
export const ACTIVITY_STALE_MS = RECORDER_ACTIVITY_STALE_MS;

/** The person's own browsers in the order the Browser button tries them: Chrome first, then Edge. */
const REAL_BROWSERS: readonly RealBrowser[] = ["chrome", "msedge"];
/** Which store each of them installs the Recorder from. */
const STORE_OF: Record<RealBrowser, "chrome" | "edge"> = {
  chrome: "chrome",
  msedge: "edge",
};

/** How much of the computer's sentence a failure's log line keeps: every sentence it says, and never a page of text. */
const ERROR_LOG_CHARS = 500;
/** Narration is the largest body here: 4,000 characters of one phrase, as UTF-8, with room for the rest. */
const BODY_LIMIT_BYTES = 16 * 1024;
/** Launching a browser, loading the Recorder and handing it its connection takes seconds; a cold computer more. */
const OPEN_TIMEOUT_MS = 90_000;
/**
 * How long OpenBot waits for the computer to answer. Longer than the computer's own navigation timeout
 * (agent-computer's NAVIGATION_TIMEOUT_MS, 30 s by default), so a page that does not load is answered by the computer,
 * which can say which page and why, rather than by OpenBot giving up at the same moment and blaming the browser. The
 * deadline the Bots' computer transport gives a browser action (computer/client.ts).
 */
export const CALL_TIMEOUT_MS = 45_000;
/**
 * How long OpenBot waits for the browser's state: under the 10 s after which `Bun.serve` closes a request that has sent
 * nothing (its default `idleTimeout`), and over the 5 s the computer gives the browser before it answers that the
 * browser is not answering (agent-computer's STATE_ANSWER_MS). A browser that answers at all answers in milliseconds.
 *
 * It used to be {@link CALL_TIMEOUT_MS}. When the person's browser stopped answering in the end-to-end run, the state
 * waited 45 s for it, and the person's request had already ended with an empty reply at 10: the Browser page had
 * nothing to show and nothing to say, and the sidebar's Browser button went away.
 */
export const STATE_TIMEOUT_MS = 8_000;
/**
 * HOW LONG EACH OF THESE ROUTES HAS TO ANSWER THE PERSON, from the moment their request arrives, and how long OpenBot's
 * server keeps their request open for it (`browserRequestSeconds`, which http-server.ts applies with Bun's
 * `server.timeout(request, seconds)`).
 *
 * `Bun.serve` closes a request that has sent nothing for 10 s, its default `idleTimeout`, while a handler is still at
 * work. These routes wait on the person's computer for up to {@link CALL_TIMEOUT_MS}, and an open for
 * {@link OPEN_TIMEOUT_MS}, so a cold open or a slow page ended in an empty reply: the computer's answer, or OpenBot's own
 * sentence, arrived after the person's request was gone, and the app said only its own fallback.
 *
 * So each route has a budget, which every wait inside it shares: finding the computer (a supervisor's `/ensure` waits up
 * to 120 s for a container that was asleep), and each call to it, which is cut short to what is left. Spent, the route
 * answers that the browser is taking too long. And the person's request is kept open for the budget, the one state read
 * that may follow it ({@link STATE_TIMEOUT_MS}) and a margin for the database, so the answer always reaches them.
 */
/** An open, and a Record, which may open the browser's connection again first: a computer woken from sleep, then a
 * browser launched, the Recorder loaded and handed its connection. And a clear, which wipes the browser and opens it
 * again. */
export const OPEN_BUDGET_MS = 150_000;
/** Tabs, an address, a phrase or a close: the computer's own wait, and finding the computer it runs on. */
export const CALL_BUDGET_MS = CALL_TIMEOUT_MS + 15_000;
/** What the person's request is kept open for past its budget and a state read: the database, and the answer itself. */
const ANSWER_MARGIN_MS = 7_000;

/** How long OpenBot's server keeps open a request whose route has `budgetMs`, in seconds: its budget, the one state read
 * that may follow it, and a margin for the database and the answer itself. */
export function requestSecondsFor(budgetMs: number): number {
  return Math.ceil((budgetMs + STATE_TIMEOUT_MS + ANSWER_MARGIN_MS) / 1000);
}

/**
 * How long OpenBot's server keeps a person's request to one of these routes open, in seconds, or undefined for the state
 * route, which answers within {@link STATE_TIMEOUT_MS} and keeps Bun's own 10 s.
 */
export function browserRequestSeconds(pathname: string): number | undefined {
  const budget =
    pathname === browserApiPaths.open ||
    pathname === browserApiPaths.recording ||
    pathname === browserApiPaths.clear
      ? OPEN_BUDGET_MS
      : pathname.startsWith(`${browserApiPaths.state}/`)
        ? CALL_BUDGET_MS
        : undefined;
  if (budget === undefined) return undefined;
  return requestSecondsFor(budget);
}

/** When the request being answered must have its answer by (epoch ms): set by each route, read by every wait in it. */
const answerBy = new AsyncLocalStorage<number>();

/** A route's budget of `ms` from the request's arrival, which every wait in it shares (`inBudget`, `computerCaller`):
 * the person's own browser's routes, and a Bot's (browser/bot-browser.ts). */
export const withBudget =
  (ms: number): MiddlewareHandler =>
  (_context, next) =>
    answerBy.run(Date.now() + ms, next);

/** What is left of the request's budget, in ms; unbounded outside a route (a revoke's notice, say). */
function budgetLeft(): number {
  const by = answerBy.getStore();
  return by === undefined ? Number.POSITIVE_INFINITY : by - Date.now();
}

/** The work, unless the request's budget runs out first: then the person is told their browser is taking too long
 * (`slow`: a Bot's browser says it is the Bot's). */
export async function inBudget<T>(
  work: Promise<T>,
  path: string,
  slow: string = SENTENCES.slow,
): Promise<T> {
  const left = budgetLeft();
  if (!Number.isFinite(left)) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        console.warn(
          JSON.stringify({ type: "browser-computer-slow", path, budget: true }),
        );
        reject(new BrowserCallError(slow, 504));
      },
      Math.max(0, left),
    );
  });
  // A failure that comes after the budget ran out has nobody waiting for it, and must not end the process unheard.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long the computer may take to clear the person's browser: a recording in it stopped and the last of it waited for
 * (the computer's SENDING_WAIT_MS, 20 s), the browser closed and given 2 s to finish writing, and its profile deleted.
 */
const CLEAR_TIMEOUT_MS = 60_000;

/**
 * The local actor's address, matched to decide whether the id is a real users row: the audit table's foreign key takes
 * no other (computer/routes.ts `actorOf` has the same rule).
 */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

/**
 * How long a revoke waits for the person's browser to hear of it. The revoke has happened either way: a browser that
 * did not hear in time hears on its next call to OpenBot, and the state route reports it signed out meanwhile.
 */
const DISCONNECT_TIMEOUT_MS = 5_000;

/**
 * How far from its arrival a narration time may be once it is on this server's clock. A page sends a phrase as it ends,
 * so its times are moments before it was sent: one later than that by more than a page could round to, or earlier by
 * more than anyone speaks one phrase for, is a time from another clock (one counted from the page's load, say), and the
 * Recorder would place the phrase among the wrong steps or hold every step since.
 */
const NARRATION_AHEAD_MS = 2 * 60_000;
const NARRATION_BEHIND_MS = 10 * 60_000;

const SENTENCES = {
  unavailable: "This OpenBot cannot open a browser for you.",
  notSetUp:
    "Your browser can't open right now. Ask an admin to check OpenBot's setup.",
  /** `notSetUp` where the person is the admin: nobody else to ask, and something they can do (OpenBot Desktop checks
   * its setup again as it starts, the Recorder included). Never "read the logs": every sentence is for the
   * person, as Desktop's own are. */
  notSetUpSingleUser:
    "Your browser can't open right now. Quit OpenBot, open it again, and try once more.",
  tooMany:
    "Too many connection codes were asked for at once. Wait a few minutes and try again.",
  notConnected: "Your browser could not be connected. Try again.",
  noPerson: "This person could not be found. Try again.",
  unreachable: "Your browser could not be reached. Try again.",
  slow: "Your browser is taking too long to answer. The page may still be loading.",
  unclear: "Your browser opened but did not say how. Try again.",
  notAnswering:
    "Your browser isn't answering. If it doesn't come back soon, ask an admin for help.",
  /** `notAnswering` where the person runs OpenBot themselves: quitting OpenBot stops its computer, and the browser on
   * it, and opening it again starts both afresh. */
  notAnsweringSingleUser:
    "Your browser isn't answering. If it doesn't come back soon, quit OpenBot and open it again.",
  notWeb: "Only web addresses open here.",
  /** The profile is gone, and its row on the trail could not be written. */
  clearedNotFinished:
    "Your browser was cleared, but OpenBot couldn't finish. Clear it again.",
  phraseTimes:
    "That phrase's times do not fit the recording, so it was not added.",
} as const;

/**
 * Why a person's browser cannot be connected when this OpenBot has no address the Recorder would take, for whoever runs
 * OpenBot: it goes to the log, and the person is told their browser cannot open and who can see to it (`notSetUp`), as
 * for the computer's own setup failures. The fourth end-to-end run showed sentences like this one on the Browser page.
 */
const NO_ADDRESS =
  "This OpenBot has no address a person's browser can reach it at, so the Recorder in it cannot be connected. Set OPENBOT_PUBLIC_URL to this OpenBot's https address.";

/** OpenBot did not get the computer's answer: 502 when nothing answered, 504 when it took too long to. */
export class BrowserCallError extends Error {
  readonly status: 502 | 504;
  constructor(message: string, status: 502 | 504 = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * A narration request with every time moved onto this server's clock: shifted by (its arrival minus `sentAt`), which is
 * how far the person's computer's clock is from this one, with `sentAt` made the arrival. The Recorder then places the
 * phrase among steps stamped on the same clock. Null when a time still does not fit a phrase sent now
 * ({@link NARRATION_AHEAD_MS}).
 */
function onServerClock(
  request: BrowserNarrationRequest,
  arrival: number,
): BrowserNarrationRequest | null {
  const shift = (time: number) => time + (arrival - request.sentAt);
  const fits = (time: number) =>
    time <= arrival + NARRATION_AHEAD_MS &&
    time >= arrival - NARRATION_BEHIND_MS;
  if ("text" in request) {
    const startedAt = shift(request.startedAt);
    const endedAt = shift(request.endedAt);
    return fits(startedAt) && fits(endedAt)
      ? { text: request.text, startedAt, endedAt, sentAt: arrival }
      : null;
  }
  if (!request.speaking) return { speaking: false, sentAt: arrival };
  const since = shift(request.since);
  return fits(since) ? { speaking: true, since, sentAt: arrival } : null;
}

/** When each narration request reached this server, read before signing the person in can take any time. */
const arrivals = new WeakMap<Request, number>();

/** Notes when a narration request arrived. Mounted ahead of every check on the route, so the time is its arrival. */
export const stampNarrationArrival: MiddlewareHandler = async (
  context,
  next,
) => {
  arrivals.set(context.req.raw, Date.now());
  await next();
};

/**
 * A narration request's body, read against the contract and moved onto this server's clock from the time it arrived
 * ({@link stampNarrationArrival}): the request the computer is sent, or what the person is told instead (400). The same
 * for the person's own browser and a Bot's.
 */
export async function narrationOnServerClock(
  request: Request,
): Promise<
  | { ok: true; narration: BrowserNarrationRequest }
  | { ok: false; error: string }
> {
  const arrival = arrivals.get(request) ?? Date.now();
  const parsed = browserNarrationRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  const body = parsed.success ? parsed.data : null;
  if (!body || ("text" in body && body.endedAt < body.startedAt))
    return { ok: false, error: "That phrase was not complete." };
  const corrected = onServerClock(body, arrival);
  return corrected
    ? { ok: true, narration: corrected }
    : { ok: false, error: SENTENCES.phraseTimes };
}

/** A cross-site form can only send these three content types, so requiring JSON stops one. */
export const jsonOnly: MiddlewareHandler = async (context, next) => {
  if (!context.req.header("content-type")?.startsWith("application/json")) {
    return context.json({ error: "Send the request as JSON." }, 415);
  }
  await next();
};

export const smallBody = bodyLimit({
  maxSize: BODY_LIMIT_BYTES,
  onError: (context) =>
    context.json({ error: "That request is too large." }, 413),
});

/** A browser's state as the computer reports it, checked for the two fields every answer has. */
export function browserState(value: unknown): BrowserState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Partial<BrowserState>;
  return typeof state.open === "boolean" && Array.isArray(state.tabs)
    ? (value as BrowserState)
    : null;
}

/** Who hears the person, which the window decides: a native window has a microphone, so the Recorder hears them
 * itself, and a screen has none, so the app hears them. The computer connects the Recorder with exactly that. Only
 * when no window is known is it what the Recorder says. */
function narrationOf(state: BrowserState): Narration | undefined {
  if (state.window === "native") return "own";
  if (state.window === "screen") return "external";
  return state.recorder?.narration;
}

/**
 * The Recorder's report as the contract has it for the browser's narration: `voice` only where the Recorder hears the
 * person itself, and never where the app does. A Recorder that is signed out has forgotten the narration it was handed
 * with its connection and reports its own default, `own` with a voice, in a screen's browser too (seen after a hosted
 * Disconnect); the window, not that default, is who hears the person. A Recorder hearing them itself that said nothing
 * of its voice is not hearing them: off while nothing is recorded, unavailable while something is.
 */
function asNarrated(
  recorder: LauncherState,
  narration: Narration,
): LauncherState {
  const { voice, ...rest } = recorder;
  if (narration === "external") return { ...rest, narration };
  return {
    ...rest,
    narration,
    voice: voice ?? (recorder.phase === "idle" ? "off" : "unavailable"),
  };
}

/** The Recorder's report once its connection is gone: signed out, as it reports itself after OpenBot signs it out. */
function signedOut(recorder: LauncherState): LauncherState {
  const { userId: _revoked, ...rest } = recorder;
  return { ...rest, connected: false };
}

/** What a person is told when the computer does not answer: about their own browser, unless a caller says whose. */
const NOT_ANSWERED = {
  slow: SENTENCES.slow,
  unreachable: SENTENCES.unreachable,
};

/** One computer route for a person's browser (or a Bot's, browser/bot-browser.ts), under the computer token with the
 * browser in `x-openbot-bot-id`: a GET, or a POST of `body` (a POST with no body when `method` says so). */
export function computerCaller(
  deps: Pick<BrowserRouteDeps, "token" | "fetchImpl" | "callTimeoutMs">,
  words: { slow: string; unreachable: string } = NOT_ANSWERED,
) {
  const doFetch = deps.fetchImpl ?? fetch;
  const callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  return async function ask(
    base: string,
    /** The browser's id, or a Bot's seat as the gateway names it (`addressOf`): with its person on the shared computer. */
    computerId: SeatAddress,
    path: string,
    options: {
      body?: unknown;
      method?: "POST";
      timeoutMs?: number;
      /** A status that is an answer here rather than a failure, which is therefore not logged as one. */
      answers?: number;
      /** Asked whatever is left of the request's budget: the state read after the work, which is bounded itself. */
      pastBudget?: boolean;
    } = {},
  ): Promise<{ status: number; body: unknown }> {
    const { body } = options;
    // The request's budget cuts a call short; spent already, the call is not made.
    const timeoutMs = Math.min(
      options.timeoutMs ?? callTimeoutMs,
      options.pastBudget ? Number.POSITIVE_INFINITY : budgetLeft(),
    );
    if (timeoutMs <= 0) {
      console.warn(
        JSON.stringify({ type: "browser-computer-slow", path, budget: true }),
      );
      throw new BrowserCallError(words.slow, 504);
    }
    const checked = checkComputerAddress(base);
    if (!checked.allowed) throw new BrowserCallError(checked.reason);
    let response: Response;
    try {
      response = await doFetch(`${base.replace(/\/$/, "")}${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          ...seatHeaders(computerId),
          ...(deps.token ? { "x-openbot-computer-token": deps.token } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Nothing came back in time. A computer that is not running refuses the connection at once, so this one, as a rule,
      // took the request and is still at it: a page that will not finish loading, most often. Not an outage, and not
      // said as one.
      if (error instanceof Error && error.name === "TimeoutError") {
        console.warn(
          JSON.stringify({ type: "browser-computer-slow", path, timeoutMs }),
        );
        throw new BrowserCallError(words.slow, 504);
      }
      console.error(
        JSON.stringify({
          type: "browser-computer-unreachable",
          path,
          error: error instanceof Error ? error.name : String(error),
        }),
      );
      throw new BrowserCallError(words.unreachable);
    }
    const answered: unknown = await response.json().catch(() => null);
    // The computer answered and said what went wrong, to the person: a page that did not load, a Recorder that failed.
    // Its sentence is logged with the status, because it is the only place the reason is said: an open that failed
    // used to leave a status here and nothing in either log about why.
    if (response.status >= 500 && response.status !== options.answers) {
      const said = (answered as { error?: unknown } | null)?.error;
      console.warn(
        JSON.stringify({
          type: "browser-computer-failed",
          path,
          status: response.status,
          ...(typeof said === "string" && said
            ? { error: said.slice(0, ERROR_LOG_CHARS) }
            : {}),
        }),
      );
    }
    return { status: response.status, body: answered };
  };
}

/** Whether these, a person's live connections, hold one for their OpenBot browser: the one stored under the browser's
 * install id, which an open keeps while the Recorder holds it and replaces when it does not. */
function holdsBrowserConnectionIn(
  live: readonly RecorderConnection[],
  userId: string,
): boolean {
  const installId = personBrowserInstallId(personBrowserId(userId));
  return live.some((connection) => connection.installId === installId);
}

/** Whether OpenBot holds a live Recorder connection for this person's OpenBot browser. */
async function holdsBrowserConnection(
  connections: BrowserRouteDeps["recorder"]["connections"],
  userId: string,
): Promise<boolean> {
  return holdsBrowserConnectionIn(await connections.list(userId), userId);
}

/**
 * Whether the Recorder in this browser holds the connection `connectionId` for `userId`, with the narration its window
 * wants: then it is kept rather than made again (`connectNow`). A Recorder from before it named its connection never
 * matches, and is connected again as before.
 */
function keeps(
  state: BrowserState,
  connectionId: string,
  userId: string,
): boolean {
  const recorder = state.recorder;
  return (
    recorder?.connected === true &&
    recorder.userId === userId &&
    recorder.connectionId === connectionId &&
    recorder.narration === narrationOf(state)
  );
}

/** A Recorder's own report as the red dot reads it: what it is recording, and nothing of how it hears the person. */
function activityOf(recorder: LauncherState): RecorderActivity {
  return {
    phase: recorder.phase,
    ...(recorder.recordingId ? { recordingId: recorder.recordingId } : {}),
    ...(recorder.title !== undefined ? { title: recorder.title } : {}),
    ...(recorder.startedAt ? { startedAt: recorder.startedAt } : {}),
    actions: recorder.actions,
  };
}

/**
 * What the person's Recorders are doing, for the Browser button's red dot (`BrowserApiState.activity`): the newest
 * report from any of their live connections, whatever way it was connected, that is no older than
 * {@link ACTIVITY_STALE_MS} and is of a recording (a Recorder that last said it was idle is not recording); or the
 * OpenBot browser's own Recorder, as its computer reported it just now, whichever is newer. Undefined while nothing
 * records.
 *
 * What the OpenBot browser's computer says now is newer than anything its Recorder reported, so when the computer was
 * asked (`browser`), that Recorder's last report gives way to it: a Stop whose report did not arrive does not keep the
 * dot on for a minute and a half.
 */
export function newestActivity(input: {
  reports: readonly ReportingConnection[];
  /** The OpenBot browser's install id, and its Recorder as its computer reported it just now (none: it is closed). */
  browser?: { installId: string; recorder?: LauncherState };
  now: number;
}): RecorderActivity | undefined {
  const live = input.browser?.recorder;
  if (live && live.phase !== "idle") return activityOf(live);
  let newest: { activity: RecorderActivity; at: number } | undefined;
  for (const report of input.reports) {
    const { activity, activityAt } = report;
    if (!activity || !activityAt || activity.phase === "idle") continue;
    if (input.browser && report.installId === input.browser.installId) continue;
    const at = activityAt.getTime();
    if (input.now - at > ACTIVITY_STALE_MS) continue;
    if (!newest || at > newest.at) newest = { activity, at };
  }
  return newest?.activity;
}

/**
 * Which of the person's own browsers a Recorder connected through OpenBot Desktop is in, from the name it connected
 * under. The Recorder names itself for its browser's brand and the computer ("Microsoft Edge on macOS", "Google Chrome
 * on Windows": extension/src/pages/connect/connect-page.tsx), so a name that says Edge is Edge. Anything else is
 * Chrome, which a name that does not say is far more likely to be, and which Desktop tries first besides.
 */
export function realBrowserOf(label: string): RealBrowser {
  return /\bedge\b/i.test(label) ? "msedge" : "chrome";
}

/** The connection the person was last heard from on: its last report, else its last use, else its connecting. */
function lastHeardFrom<T extends ReportingConnection>(
  connections: readonly T[],
): T | undefined {
  const heard = (connection: T) =>
    Math.max(
      connection.activityAt?.getTime() ?? 0,
      Date.parse(connection.lastUsedAt ?? connection.createdAt),
    );
  let latest: T | undefined;
  for (const connection of connections)
    if (!latest || heard(connection) > heard(latest)) latest = connection;
  return latest;
}

/**
 * Tells a person's own OpenBot browser that OpenBot revoked its Recorder connection: what a Disconnect in Settings,
 * Browsers does next (recorder/routes.ts, wired in app.ts). On its own the Recorder hears of a revoke only on its next
 * call to OpenBot, which on a quiet browser is its keep-alive, hours away, and says it is connected until then. So the
 * browser's computer has it forget the connection now (`POST /browser/disconnect`), as it would on hearing OpenBot say
 * its token is gone.
 *
 * Best effort, and never a reason the revoke fails: the token is revoked already. A browser that is closed, one whose
 * computer is not running (never started for this), or one that cannot be reached or is slow to answer hears on its
 * next call instead, and the state route reports it signed out meanwhile. Only the browser's own connection is its to
 * forget: not another browser's, and not one a newer connection of this browser replaced meanwhile (an open, or a
 * Record that connected it again).
 */
export function browserConnectionRevoked(
  deps: Pick<
    BrowserRouteDeps,
    "computers" | "token" | "recorder" | "fetchImpl" | "callTimeoutMs"
  >,
): (userId: string, connection: RecorderConnection) => Promise<void> {
  const ask = computerCaller(deps);
  return async (userId, connection) => {
    const computers = deps.computers;
    const computerId = personBrowserId(userId);
    if (
      !computers ||
      connection.via !== "openbot-browser" ||
      connection.installId !== personBrowserInstallId(computerId)
    )
      return;
    try {
      if (await holdsBrowserConnection(deps.recorder.connections, userId))
        return;
      if (!(await computers.running(computerId))) return;
      const base = await computers.locate(computerId);
      const answer = await ask(
        base,
        computerId,
        browserComputerPaths.disconnect,
        {
          method: "POST",
          timeoutMs: deps.callTimeoutMs ?? DISCONNECT_TIMEOUT_MS,
        },
      );
      // A browser that is not open has nothing to forget (409): it is handed a new connection when it opens.
      if (
        (answer.status >= 200 && answer.status < 300) ||
        answer.status === 409
      )
        return;
      console.warn(
        JSON.stringify({
          type: "browser-disconnect-refused",
          status: answer.status,
        }),
      );
    } catch (error) {
      // An unreachable or slow computer is logged where it was asked.
      if (!(error instanceof BrowserCallError))
        console.error(
          JSON.stringify({
            type: "browser-disconnect-failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  };
}

/**
 * Whether an address the person typed may be opened: a web address, or one with no scheme for the browser to read as
 * one. Never `file:`, `chrome:`, `javascript:` or `data:`: on a computer in the cloud the first reads the computer's own
 * disk, where other people's browser profiles are kept. `example.com:8080` is a host and port, not a scheme.
 */
export function isWebAddress(input: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(input.trim())?.[1];
  return (
    scheme === undefined || ["http", "https"].includes(scheme.toLowerCase())
  );
}

/**
 * The computer's refusal, for the person. What is about their request keeps its status and the computer's sentence: a
 * bad request (400), a browser that is not open or a Recorder that refused (409). What is about how OpenBot reaches its
 * computer (the token, a route an older computer lacks) is never passed on as the person's own 401 or 404: it is the
 * computer failing, 502, as a Recorder or a page that failed is, with the computer's sentence where it said one for the
 * person.
 *
 * A browser this computer cannot run at all (503: no built Recorder on it, or no Chrome or Edge) is OpenBot's setup, not
 * anything the person did or can do. The computer's sentence for it is written for whoever runs OpenBot: it names
 * `OPENBOT_RECORDER_DIR` and a build command, and the fourth end-to-end run showed it on the Browser page. So the person
 * is told `words.notSetUp`, which says who can see to it, and the computer's own sentence stays in both logs
 * (`browser-computer-failed` here, `computer-browser-open-failed` on the computer).
 */
export function computerRefusal(
  answer: { status: number; body: unknown },
  words: { notSetUp: string; unreachable: string },
): Response {
  const said = (answer.body as { error?: unknown } | null)?.error;
  const sentence = typeof said === "string" && said ? said : null;
  if (answer.status === 503)
    return Response.json({ error: words.notSetUp }, { status: 503 });
  if (answer.status === 400 || answer.status === 409)
    return Response.json(
      { error: sentence ?? words.unreachable },
      { status: answer.status },
    );
  return Response.json(
    {
      error: answer.status >= 500 && sentence ? sentence : words.unreachable,
    },
    { status: 502 },
  );
}

/** A call to the computer that got no answer, for the person: what `computerCaller` said, else `unreachable`. */
export function callFailed(error: unknown, unreachable: string): Response {
  return error instanceof BrowserCallError
    ? Response.json({ error: error.message }, { status: error.status })
    : Response.json({ error: unreachable }, { status: 502 });
}

/**
 * The person's own OpenBot browser: open it, see it, record in it, narrate, move between its tabs and close it. Every
 * route is the signed-in person's own browser, named from who is asking (browser/person.ts), so there is no id in the
 * path to ask for anybody else's.
 *
 * Opening it connects the Recorder in it as this person with no Connect step: OpenBot mints the connection itself, as
 * the exchange would (recorder/connections.ts), sealing the person's organization session from this request as the
 * connect-code route does, and hands it to the computer, which hands it to the Recorder over the DevTools pipe only the
 * launcher holds. It is one more connected browser, in Settings, Browsers like any other, and can be disconnected there.
 * Once connected, it stays so: opening it again keeps the connection while it stands (`connectNow`).
 */
export function createBrowserRoutes(deps: BrowserRouteDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const audit = recorderAudit(deps.auditStore);
  /** The route's budget, from the request's arrival: every wait in it shares it (`answerBy`). */
  const openBudget = withBudget(deps.budgetMs?.open ?? OPEN_BUDGET_MS);
  const callBudget = withBudget(deps.budgetMs?.call ?? CALL_BUDGET_MS);
  const ask = computerCaller(deps);
  /** What the person is told when OpenBot's own setup stops their browser opening: ask an admin, unless they are it. */
  const notSetUp = deps.singleUser
    ? SENTENCES.notSetUpSingleUser
    : SENTENCES.notSetUp;
  const refused = (answer: { status: number; body: unknown }) =>
    computerRefusal(answer, { notSetUp, unreachable: SENTENCES.unreachable });
  const unreachable = (error: unknown) =>
    callFailed(error, SENTENCES.unreachable);
  /** What the person is told when their browser is open and not answering: the same two ways round. */
  const notAnswering = deps.singleUser
    ? SENTENCES.notAnsweringSingleUser
    : SENTENCES.notAnswering;

  /** Whether this OpenBot can run the person's browser, where it shows when it can, and why not when that wants
   * saying: the same answer open or closed, decided by where people's browsers run here rather than by asking the
   * browser. */
  const where = (): Pick<BrowserApiState, "available" | "shows" | "note"> => ({
    ...(deps.computers
      ? { available: true, shows: deps.computers.shows }
      : { available: false }),
    ...(deps.note ? { note: deps.note } : {}),
  });
  /** What a request that needs a browser is told where this OpenBot cannot run one. */
  const unavailable = deps.note ?? SENTENCES.unavailable;

  const closed = (computerId: string): BrowserApiState => ({
    ...where(),
    computerId,
    open: false,
    tabs: [],
  });

  /**
   * The person's browser as they see it. The Recorder's report is taken as it says, except that a Recorder holding a
   * connection OpenBot revoked is signed out whatever it says: OpenBot tells it of a revoke at once
   * (`browserConnectionRevoked`), and when that did not reach it, it hears only on its next call to OpenBot. And its
   * narration is the window's, signed in or out (`asNarrated`). `live` is the person's live connections, when they were
   * read already.
   */
  const view = async (
    userId: string,
    state: BrowserState,
    live?: readonly RecorderConnection[],
  ): Promise<BrowserApiState> => {
    const narration = narrationOf(state);
    const recorder = state.recorder;
    const revoked =
      recorder?.connected === true &&
      !(live
        ? holdsBrowserConnectionIn(live, userId)
        : await holdsBrowserConnection(deps.recorder.connections, userId));
    const reported = recorder && revoked ? signedOut(recorder) : recorder;
    return {
      ...state,
      ...(reported
        ? {
            recorder: narration ? asNarrated(reported, narration) : reported,
          }
        : {}),
      ...where(),
      computerId: personBrowserId(userId),
      ...(narration ? { narration } : {}),
    };
  };

  /**
   * The person's own browsers installed on OpenBot Desktop's computer, as it lists them (`GET /browser/real`), which
   * launches nothing. Never fails: a computer that cannot be asked, or an answer of another shape, has none.
   */
  async function installedBrowsers(
    base: string,
    computerId: string,
  ): Promise<RealBrowser[]> {
    try {
      const answer = await ask(
        base,
        computerId,
        realBrowserComputerPaths.installed,
      );
      const listed = (answer.body as { browsers?: unknown } | null)?.browsers;
      if (answer.status !== 200 || !Array.isArray(listed)) return [];
      return REAL_BROWSERS.filter((browser) => listed.includes(browser));
    } catch {
      return [];
    }
  }

  /**
   * The browser's state, as its computer says it within {@link STATE_TIMEOUT_MS}: the state; `silent` when the browser
   * did not answer (the computer said so, 504, or the computer itself said nothing in time); or `failed` when it could
   * not be asked or answered something else, which reads as closed, and opening it says why.
   */
  async function askState(
    base: string,
    computerId: string,
  ): Promise<{ state: BrowserState } | "silent" | "failed"> {
    try {
      const answer = await ask(base, computerId, browserComputerPaths.state, {
        timeoutMs: STATE_TIMEOUT_MS,
        // The browser not answering, which the computer logs once when it stops; the page asks every second.
        answers: 504,
        // Bounded by its own timeout, which the request is kept open for past its budget.
        pastBudget: true,
      });
      if (answer.status === 504) return "silent";
      const state = answer.status === 200 ? browserState(answer.body) : null;
      return state ? { state } : "failed";
    } catch (error) {
      return error instanceof BrowserCallError && error.status === 504
        ? "silent"
        : "failed";
    }
  }

  /** The browser that is not answering, as the person sees it: nothing of it to show, and the sentence why. */
  const silent = (computerId: string): BrowserApiState => ({
    ...closed(computerId),
    problem: notAnswering,
  });

  /**
   * What the computer the person's browser runs on says, when it is running: asking never starts one. The OpenBot
   * browser's state (null: it could not be asked, which reads as closed), whether it is `silent` (open and not
   * answering), and, when `real` asks for them (OpenBot Desktop), the person's own browsers installed there. Never fails
   * for the computer.
   */
  async function askComputer(
    computerId: string,
    real: boolean,
  ): Promise<{
    state: BrowserState | null;
    silent: boolean;
    browsers: RealBrowser[];
  }> {
    const computers = deps.computers;
    const none = { state: null, silent: false, browsers: [] };
    if (!computers) return none;
    let base: string;
    try {
      if (!(await computers.running(computerId))) return none;
      base = await inBudget(computers.locate(computerId), "locate");
    } catch {
      return none;
    }
    const [asked, browsers] = await Promise.all([
      askState(base, computerId),
      real ? installedBrowsers(base, computerId) : [],
    ]);
    return {
      state: typeof asked === "object" ? asked.state : null,
      silent: asked === "silent",
      browsers,
    };
  }

  /** The browser as it is now, for the person to see. Never fails for the computer: a browser that cannot be asked is
   * one that is not open, and opening it says why; one that does not answer says so. */
  async function currentState(userId: string): Promise<BrowserApiState> {
    const computerId = personBrowserId(userId);
    const asked = await askComputer(computerId, false);
    if (asked.silent) return silent(computerId);
    return asked.state ? view(userId, asked.state) : closed(computerId);
  }

  /**
   * The state the app reads (`GET /api/browser`): the browser as it is now, what any of the person's Recorders is
   * recording (`activity`, the Browser button's red dot), and on OpenBot Desktop the person's own browsers and whether
   * a Recorder in one is connected through Desktop (`real`). One query for every Recorder connection the person has,
   * beside the computer it already asked; nothing is started or reached that the state did not reach before.
   */
  async function apiState(userId: string): Promise<BrowserApiState> {
    const computerId = personBrowserId(userId);
    if (!deps.computers) return closed(computerId);
    const native = deps.computers.shows === "native";
    const [reports, asked] = await Promise.all([
      deps.recorder.connections.reporting(userId),
      askComputer(computerId, native),
    ]);
    const state = asked.silent
      ? silent(computerId)
      : asked.state
        ? await view(userId, asked.state, reports)
        : closed(computerId);
    const activity = newestActivity({
      reports,
      now: Date.now(),
      ...(asked.state
        ? {
            browser: {
              installId: personBrowserInstallId(computerId),
              ...(asked.state.recorder
                ? { recorder: asked.state.recorder }
                : {}),
            },
          }
        : {}),
    });
    return {
      ...state,
      ...(native
        ? {
            real: {
              connected: reports.some(
                (connection) => connection.via === "desktop",
              ),
              browsers: asked.browsers,
            },
          }
        : {}),
      ...(activity ? { activity } : {}),
    };
  }

  /**
   * On OpenBot Desktop, the Browser button works with the person's own everyday Chrome or Edge rather than the OpenBot
   * browser, once the Recorder can be in it. Answers what it did, or null to open the OpenBot browser as before.
   *
   * - A Recorder connected through Desktop (`via: "desktop"`): its browser is brought forward. Which browser is read
   *   from the name the connection was made under (`realBrowserOf`), on the connection the person was heard from last.
   * - None, and the Recorder is published for one of the person's installed browsers: its store page opens in that
   *   browser, Chrome first, for the person to add it.
   * - Neither: null, and the OpenBot browser opens, so the button keeps working until the Recorder is published. Before
   *   then the computer is not even asked which browsers are installed.
   */
  async function openReal(userId: string): Promise<Response | null> {
    const computers = deps.computers;
    if (!computers) return null;
    const computerId = personBrowserId(userId);
    const connected = lastHeardFrom(
      (await deps.recorder.connections.reporting(userId)).filter(
        (connection) => connection.via === "desktop",
      ),
    );
    if (connected) {
      const browser = realBrowserOf(connected.label);
      try {
        const base = await inBudget(computers.locate(computerId), "locate");
        const answer = await ask(
          base,
          computerId,
          realBrowserComputerPaths.front,
          {
            body: { browser } satisfies RealBrowserRequest,
          },
        );
        if (answer.status < 200 || answer.status >= 300) return refused(answer);
      } catch (error) {
        return unreachable(error);
      }
      return Response.json({
        ok: true,
        opened: "real",
        browser,
      } satisfies RealBrowserOpenResponse);
    }

    const storeIds = deps.storeIds ?? RECORDER_STORE_IDS;
    const published = REAL_BROWSERS.filter(
      (browser) => storeIds[STORE_OF[browser]],
    );
    if (published.length === 0) return null;
    let base: string;
    try {
      base = await inBudget(computers.locate(computerId), "locate");
    } catch {
      // The OpenBot browser's open locates the same computer, and says why it could not.
      return null;
    }
    const installed = await installedBrowsers(base, computerId);
    const browser = published.find((each) => installed.includes(each));
    const id = browser ? storeIds[STORE_OF[browser]] : undefined;
    if (!browser || !id) return null;
    try {
      const answer = await ask(
        base,
        computerId,
        realBrowserComputerPaths.store,
        {
          body: {
            browser,
            url: recorderStorePage(STORE_OF[browser], id),
          } satisfies RealBrowserRequest,
        },
      );
      if (answer.status < 200 || answer.status >= 300) return refused(answer);
    } catch (error) {
      return unreachable(error);
    }
    return Response.json({
      ok: true,
      opened: "store",
      browser,
    } satisfies RealBrowserOpenResponse);
  }

  /** Forwards one request to the person's browser. `answer` is what the person is told when it was taken: the browser's
   * state after it, by default, as the contract's routes answer. */
  async function forward(
    userId: string,
    path: string,
    body: unknown,
    answer: (state: BrowserState | null) => Promise<unknown> = async (state) =>
      state ? view(userId, state) : currentState(userId),
  ): Promise<Response> {
    const computerId = personBrowserId(userId);
    const computers = deps.computers;
    if (!computers)
      return Response.json({ error: unavailable }, { status: 503 });
    let taken: { status: number; body: unknown };
    try {
      const base = await inBudget(computers.locate(computerId), "locate");
      taken = await ask(base, computerId, path, { body });
    } catch (error) {
      return unreachable(error);
    }
    if (taken.status < 200 || taken.status >= 300) return refused(taken);
    return Response.json(await answer(browserState(taken.body)));
  }

  /** The body, read against the contract's schema; null when it does not match. */
  async function parsed<T extends z.ZodType>(
    request: Request,
    schema: T,
  ): Promise<z.infer<T> | null> {
    const body = schema.safeParse(await request.json().catch(() => null));
    return body.success ? body.data : null;
  }

  /** Who is asking, and what of their request opening their browser needs. */
  type Asker = {
    actor: AuthenticatedActor;
    origin: string | undefined;
    cookie: string | undefined;
  };
  const askerOf = (context: {
    var: AppVariables;
    req: { header(name: string): string | undefined };
  }): Asker => ({
    actor: context.var.actor,
    origin: context.req.header("origin"),
    cookie: context.req.header("cookie"),
  });

  /** Each person's open in progress, which the next one waits for. */
  const connecting = new Map<string, Promise<void>>();

  /**
   * Opens the person's browser, or brings it forward, with its Recorder connected as them: what Open does, and what
   * Record does first when the Recorder's connection has gone. Answers the browser's state, or what the person is told.
   *
   * One at a time for each person. An open that mints the browser a connection revokes the one before it, and the
   * Recorder asks OpenBot whether its connection stands before it takes it. Two opens side by side (the Browser
   * page loaded again while it was opening) handed the Recorder a connection the second had revoked already: it refused
   * it, the computer closed the browser it had just launched, and both opens failed (agent-computer's browser-host.ts
   * has the measurement). Waiting here, a connection is never revoked before the open that minted it has its answer. The
   * computer takes turns as well, for opens that reach it through another of OpenBot's servers.
   */
  async function connect(
    asker: Asker,
  ): Promise<
    { ok: true; state: BrowserState | null } | { ok: false; response: Response }
  > {
    const key = asker.actor.id;
    const run = (connecting.get(key) ?? Promise.resolve()).then(() =>
      connectNow(asker),
    );
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    connecting.set(key, settled);
    void settled.then(() => {
      if (connecting.get(key) === settled) connecting.delete(key);
    });
    return run;
  }

  /** One open of the person's browser on its computer: with a new connection for its Recorder, or with none, when
   * its Recorder keeps the one it holds. Answers the browser's state, or what the person is told. */
  async function openOn(
    base: string,
    computerId: string,
    request: BrowserOpenRequest,
  ): Promise<
    { ok: true; state: BrowserState | null } | { ok: false; response: Response }
  > {
    try {
      const answer = await ask(base, computerId, browserComputerPaths.open, {
        body: request,
        timeoutMs: OPEN_TIMEOUT_MS,
      });
      if (answer.status < 200 || answer.status >= 300)
        return { ok: false, response: refused(answer) };
      const state = browserState(answer.body);
      if (state?.browser && state.window) return { ok: true, state };
      // The computer answers its state; one that answered something else is asked for it.
      const asked = await askState(base, computerId);
      return {
        ok: true,
        state: typeof asked === "object" ? asked.state : null,
      };
    } catch (error) {
      return { ok: false, response: unreachable(error) };
    }
  }

  /**
   * One open, `connect`'s turn.
   *
   * A connection that stands is kept. When OpenBot holds a live connection for this browser (its install id, within its
   * lifetime) and the Recorder in it holds that same one, for this person and with the narration the window wants, the
   * browser is opened, or brought forward, with no new connection: the Recorder keeps it. That includes a browser that
   * was closed, whose Recorder kept its connection in its profile. Minting at every open revoked the last connection
   * each time, and wrote a `recorder.revoked` and a `recorder.connected` row for every visit to the Browser page and
   * many a Record.
   *
   * Otherwise (OpenBot holds none, or the Recorder turned out to hold another or none) the connection is minted here and
   * exchanged at once, as the Recorder's own exchange would: the same store, the same checks, the sealed organization
   * session carried from this request, and handed to the browser that is now open. Its install id is the browser's, so
   * this revokes the token the last one made, in the same transaction, rather than adding another.
   */
  async function connectNow(
    asker: Asker,
  ): Promise<
    { ok: true; state: BrowserState | null } | { ok: false; response: Response }
  > {
    const refuse = (error: string, status: number) => ({
      ok: false as const,
      response: Response.json({ error }, { status }),
    });
    const { actor } = asker;
    const computerId = personBrowserId(actor.id);
    const computers = deps.computers;
    if (!computers) return refuse(unavailable, 503);
    const openbotUrl = deps.openbotUrl(asker.origin);
    if (!openbotUrl) {
      console.warn(
        JSON.stringify({ type: "browser-open-no-address", error: NO_ADDRESS }),
      );
      return refuse(notSetUp, 503);
    }
    let base: string;
    try {
      base = await inBudget(computers.locate(computerId), "locate");
    } catch (error) {
      return { ok: false, response: unreachable(error) };
    }

    const installId = personBrowserInstallId(computerId);
    const held = (await deps.recorder.connections.list(actor.id)).find(
      (connection) => connection.installId === installId,
    );
    if (held) {
      const kept = await openOn(base, computerId, {});
      if (!kept.ok) return kept;
      if (kept.state && keeps(kept.state, held.id, actor.id)) return kept;
    }

    const minted = await deps.recorder.connections.mintCode(
      actor.id,
      "openbot-browser",
      await deps.recorder.sealOrganizationSession(asker.cookie),
    );
    if (!minted) {
      // The same refusal, and the same row, as the connect-code route's (recorder/routes.ts).
      await audit({
        eventType: "recorder.connect_refused",
        targetType: "recorder_connection",
        actorUserId: actor.id,
        payload: { reason: "too_many_codes", via: "openbot-browser" },
      });
      return refuse(SENTENCES.tooMany, 429);
    }
    let made: Awaited<
      ReturnType<BrowserRouteDeps["recorder"]["connections"]["exchange"]>
    >;
    try {
      made = await deps.recorder.connections.exchange({
        code: minted.code,
        label: OPENBOT_BROWSER_LABEL,
        extensionId: RECORDER_EXTENSION_ID,
        installId: personBrowserInstallId(computerId),
      });
    } catch (error) {
      // The connection and its row are written together (recorder/connections.ts), so neither was.
      console.error(
        JSON.stringify({
          type: "browser-connect-failed",
          error: reasonWithoutStatement(error),
        }),
      );
      return refuse(SENTENCES.notConnected, 500);
    }
    if (!made) return refuse(SENTENCES.notConnected, 500);
    recorderConnected({
      userId: made.userId,
      onConnected: deps.recorder.onConnected,
    });
    const user = await deps.recorder.user(actor.id);
    if (!user) return refuse(SENTENCES.noPerson, 500);

    const request = browserOpenRequestSchema.safeParse({
      connection: {
        openbotUrl,
        token: made.token,
        connectionId: made.connection.id,
        user: {
          id: user.id,
          name: user.name.slice(0, 200),
          email: user.email.slice(0, 320),
        },
      },
    } satisfies BrowserOpenRequest);
    if (!request.success) return refuse(SENTENCES.notConnected, 500);
    return openOn(base, computerId, request.data);
  }

  /**
   * Before Record: when the Recorder in the person's open browser has lost its connection, it is connected again as Open
   * does, so the recording starts under a connection that stands. Disconnect in Settings, Browsers revokes it at once and
   * tells the Recorder (`browserConnectionRevoked`), but a Recorder that was not told (its computer could not be reached
   * in time) hears only on its next call to OpenBot, which on a quiet browser is its keep-alive, hours away: until then
   * it starts a recording that its first capture pass ends, and the person is told nothing. So this asks OpenBot's own
   * record of the connection as well as the Recorder. Null to go on and record; otherwise what the person is told
   * instead. A browser that is not open is left to the computer, which refuses Record for it.
   */
  async function connectedForRecording(asker: Asker): Promise<Response | null> {
    const computers = deps.computers;
    if (!computers) return null;
    const computerId = personBrowserId(asker.actor.id);
    let base: string;
    try {
      base = await inBudget(computers.locate(computerId), "locate");
    } catch (error) {
      return unreachable(error);
    }
    const asked = await askState(base, computerId);
    // A browser that is not answering records nothing either: said now, rather than after the Record has waited.
    if (asked === "silent")
      return Response.json({ error: notAnswering }, { status: 504 });
    const state = typeof asked === "object" ? asked.state : null;
    if (!state?.open) return null;
    const standing = await holdsBrowserConnection(
      deps.recorder.connections,
      asker.actor.id,
    );
    // A Recorder that has not answered yet is taken at OpenBot's word.
    const recorder = state.recorder;
    const holdsIt =
      recorder === undefined ||
      (recorder.connected && recorder.userId === asker.actor.id);
    if (standing && holdsIt) return null;
    const again = await connect(asker);
    return again.ok ? null : again.response;
  }

  routes.get("/", deps.requireUser, async (context) =>
    context.json(await apiState(context.var.actor.id)),
  );

  routes.post("/open", openBudget, deps.requireUser, async (context) => {
    // Hosted OpenBot shows the person a cloud browser, and there is no everyday browser of theirs to bring forward.
    if (deps.computers?.shows === "native") {
      const real = await openReal(context.var.actor.id);
      if (real) return real;
    }
    const computerId = personBrowserId(context.var.actor.id);
    const connected = await connect(askerOf(context));
    if (!connected.ok) return connected.response;
    const state = connected.state;
    const browser: BrowserProduct | undefined = state?.browser;
    const window: BrowserWindow | undefined = state?.window;
    const narration = state ? narrationOf(state) : undefined;
    if (!browser || !window || !narration)
      return context.json({ error: SENTENCES.unclear }, 502);
    const answer: BrowserOpenResponse = {
      ok: true,
      computerId,
      browser,
      window,
      narration,
    };
    return context.json(answer);
  });

  routes.post(
    "/recording",
    openBudget,
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = await parsed(context.req.raw, browserRecordingRequestSchema);
      if (!body)
        return context.json({ error: "Name what you are about to do." }, 400);
      if (body.action === "start") {
        const instead = await connectedForRecording(askerOf(context));
        if (instead) return instead;
      }
      return forward(
        context.var.actor.id,
        browserComputerPaths.recording,
        body,
      );
    },
  );

  // Answered with nothing more than that it was taken: a phrase comes every few seconds while the person talks, and
  // the page polls the state on its own.
  routes.post(
    "/narration",
    callBudget,
    stampNarrationArrival,
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const read = await narrationOnServerClock(context.req.raw);
      if (!read.ok) return context.json({ error: read.error }, 400);
      return forward(
        context.var.actor.id,
        browserComputerPaths.narration,
        read.narration,
        async () => ({ ok: true }),
      );
    },
  );

  routes.post(
    "/tabs",
    callBudget,
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = await parsed(context.req.raw, browserTabsRequestSchema);
      if (!body)
        return context.json({ error: "That tab could not be found." }, 400);
      if (body.action === "new" && body.url && !isWebAddress(body.url))
        return context.json({ error: SENTENCES.notWeb }, 400);
      return forward(context.var.actor.id, browserComputerPaths.tabs, body);
    },
  );

  routes.post(
    "/navigate",
    callBudget,
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = await parsed(context.req.raw, browserNavigateRequestSchema);
      if (!body) return context.json({ error: "Type an address." }, 400);
      if ("url" in body && !isWebAddress(body.url))
        return context.json({ error: SENTENCES.notWeb }, 400);
      return forward(context.var.actor.id, browserComputerPaths.navigate, body);
    },
  );

  routes.post("/close", callBudget, deps.requireUser, async (context) =>
    forward(context.var.actor.id, browserComputerPaths.close, {}),
  );

  /**
   * Clear the person's browser (shared/bot-browser.ts, CLEARING A BROWSER), theirs alone, as every route here is. The
   * computer wipes it and leaves it closed; past that point of no return the row is written, as a computer reset's is.
   *
   * The Recorder connection OpenBot holds for this browser ends with it (`cleared`, with its `recorder.revoked` row), open
   * or closed: its token was in the profile the clear deleted, so nothing should stand for it. Left live, a closed
   * browser's stayed in Settings, Browsers as connected until the person next opened it.
   *
   * One that was open opens again at once, fresh, as Open opens it, so the person is back where they were with nothing
   * signed in, its Recorder connected anew. One that does not open again is answered closed: it was cleared, and the page
   * offers to open it.
   */
  routes.post("/clear", openBudget, deps.requireUser, async (context) => {
    const actor = context.var.actor;
    const computerId = personBrowserId(actor.id);
    const computers = deps.computers;
    if (!computers) return context.json({ error: unavailable }, 503);
    let base: string;
    let answer: { status: number; body: unknown };
    let wasOpen: boolean;
    try {
      base = await inBudget(computers.locate(computerId), "locate");
      const before = await askState(base, computerId);
      // A browser that is not answering was open, and is opened again: being stuck is the reason to clear one.
      wasOpen =
        before === "silent" ||
        (typeof before === "object" && before.state.open);
      answer = await ask(base, computerId, browserComputerPaths.clear, {
        method: "POST",
        timeoutMs: CLEAR_TIMEOUT_MS,
      });
    } catch (error) {
      return unreachable(error);
    }
    if (answer.status < 200 || answer.status >= 300) return refused(answer);
    if (deps.auditStore) {
      try {
        await recordAuditEvent(deps.auditStore, {
          eventType: "computer.browser_cleared",
          targetType: "computer",
          targetId: computerId,
          ...(actor.email === DEV_ACTOR_EMAIL ? {} : { actorUserId: actor.id }),
          payload: {
            actor: actor.id,
            reason:
              "the person cleared their own browser: its cookies, saved passwords, history and site storage",
          },
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "browser-cleared-not-recorded",
            // A failed query's message carries the values bound to it: never logged.
            error: reasonWithoutStatement(error),
          }),
        );
        return context.json({ error: SENTENCES.clearedNotFinished }, 500);
      }
    }
    try {
      const installId = personBrowserInstallId(computerId);
      for (const connection of await deps.recorder.connections.list(actor.id))
        if (connection.installId === installId)
          await deps.recorder.connections.revoke(
            actor.id,
            connection.id,
            "cleared",
          );
    } catch (error) {
      // Not ended without its row (the two are one transaction): it stands, and clearing again ends it.
      console.error(
        JSON.stringify({
          type: "browser-cleared-connection-not-revoked",
          // A failed query's message carries the values bound to it: never logged.
          error: reasonWithoutStatement(error),
        }),
      );
      return context.json({ error: SENTENCES.clearedNotFinished }, 500);
    }
    if (!wasOpen) return context.json(await currentState(actor.id));
    const opened = await connect(askerOf(context));
    if (!opened.ok) {
      console.warn(
        JSON.stringify({
          type: "browser-not-reopened-after-clear",
          status: opened.response.status,
        }),
      );
      return context.json(await currentState(actor.id));
    }
    return context.json(
      opened.state
        ? await view(actor.id, opened.state)
        : await currentState(actor.id),
    );
  });

  return routes;
}
