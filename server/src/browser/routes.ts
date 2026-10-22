import {
  type BrowserApiState,
  type BrowserNarrationRequest,
  type BrowserOpenRequest,
  type BrowserOpenResponse,
  type BrowserProduct,
  type BrowserState,
  type BrowserWindow,
  browserComputerPaths,
  browserNavigateRequestSchema,
  browserNarrationRequestSchema,
  browserOpenRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
  type LauncherState,
  type Narration,
} from "@openbot/shared/openbot-browser";
import type { RecorderConnection } from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { AuditStore } from "../audit";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import { checkComputerAddress } from "../computer/target";
import { recorderAudit, recorderConnected } from "../recorder/connected";
import type { RecorderExtensionDeps } from "../recorder/wiring";
import { personBrowserId, personBrowserInstallId } from "./person";

/** What the person sees their OpenBot browser called in Settings, Browsers, and what its connection's trail names. */
export const OPENBOT_BROWSER_LABEL = "OpenBot browser";

/** Where people's browsers run here: the computers carry them as they carry Bots' (browser/host.ts). */
export type BrowserComputers = {
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
  tooMany:
    "Too many connection codes were asked for at once. Wait a few minutes and try again.",
  notConnected: "Your browser could not be connected. Try again.",
  noPerson: "This person could not be found. Try again.",
  unreachable: "Your browser could not be reached. Try again.",
  slow: "Your browser is taking too long to answer. The page may still be loading.",
  unclear: "Your browser opened but did not say how. Try again.",
  notWeb: "Only web addresses open here.",
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
class BrowserCallError extends Error {
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

/** A cross-site form can only send these three content types, so requiring JSON stops one. */
const jsonOnly: MiddlewareHandler = async (context, next) => {
  if (!context.req.header("content-type")?.startsWith("application/json")) {
    return context.json({ error: "Send the request as JSON." }, 415);
  }
  await next();
};

const smallBody = bodyLimit({
  maxSize: BODY_LIMIT_BYTES,
  onError: (context) =>
    context.json({ error: "That request is too large." }, 413),
});

/** A browser's state as the computer reports it, checked for the two fields every answer has. */
function browserState(value: unknown): BrowserState | null {
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

/** One computer route for a person's browser, under the computer token with the browser in `x-openbot-bot-id`: a GET,
 * or a POST of `body` (a POST with no body when `method` says so). */
function computerCaller(
  deps: Pick<BrowserRouteDeps, "token" | "fetchImpl" | "callTimeoutMs">,
) {
  const doFetch = deps.fetchImpl ?? fetch;
  const callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  return async function ask(
    base: string,
    computerId: string,
    path: string,
    options: { body?: unknown; method?: "POST"; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: unknown }> {
    const { body, timeoutMs = callTimeoutMs } = options;
    const checked = checkComputerAddress(base);
    if (!checked.allowed) throw new BrowserCallError(checked.reason);
    let response: Response;
    try {
      response = await doFetch(`${base.replace(/\/$/, "")}${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          "x-openbot-bot-id": computerId,
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
        throw new BrowserCallError(SENTENCES.slow, 504);
      }
      console.error(
        JSON.stringify({
          type: "browser-computer-unreachable",
          path,
          error: error instanceof Error ? error.name : String(error),
        }),
      );
      throw new BrowserCallError(SENTENCES.unreachable);
    }
    const answered: unknown = await response.json().catch(() => null);
    // The computer answered and said what went wrong, to the person: a page that did not load, a Recorder that failed.
    // Its sentence is logged with the status, because it is the only place the reason is said: an open that failed
    // used to leave a status here and nothing in either log about why.
    if (response.status >= 500) {
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

/** Whether OpenBot holds a live Recorder connection for this person's OpenBot browser: the one stored under the
 * browser's install id, which each open replaces. */
async function holdsBrowserConnection(
  connections: BrowserRouteDeps["recorder"]["connections"],
  userId: string,
): Promise<boolean> {
  const installId = personBrowserInstallId(personBrowserId(userId));
  return (await connections.list(userId)).some(
    (connection) => connection.installId === installId,
  );
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
 * The person's own OpenBot browser: open it, see it, record in it, narrate, move between its tabs and close it. Every
 * route is the signed-in person's own browser, named from who is asking (browser/person.ts), so there is no id in the
 * path to ask for anybody else's.
 *
 * Opening it connects the Recorder in it as this person with no Connect step: OpenBot mints the connection itself, as
 * the exchange would (recorder/connections.ts), sealing the person's organization session from this request as the
 * connect-code route does, and hands it to the computer, which hands it to the Recorder over the DevTools pipe only the
 * launcher holds. It is one more connected browser, in Settings, Browsers like any other, and can be disconnected there.
 */
export function createBrowserRoutes(deps: BrowserRouteDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const audit = recorderAudit(deps.auditStore);
  const ask = computerCaller(deps);
  /** When each narration request reached this server, read before signing the person in can take any time. */
  const arrivals = new WeakMap<Request, number>();

  /**
   * The computer's refusal, for the person. What is about their request keeps its status and the computer's sentence: a
   * bad request (400), a browser that is not open or a Recorder that refused (409). What is about how OpenBot reaches
   * its computer (the token, a route an older computer lacks) is never passed on as the person's own 401 or 404: it is
   * the computer failing, 502, as a Recorder or a page that failed is, with the computer's sentence where it said one
   * for the person.
   *
   * A browser this computer cannot run at all (503: no built Recorder on it, or no Chrome or Edge) is OpenBot's setup,
   * not anything the person did or can do. The computer's sentence for it is written for whoever runs OpenBot: it names
   * `OPENBOT_RECORDER_DIR` and a build command, and the fourth end-to-end run showed it on the Browser page. So the
   * person is told their browser cannot open and who can see to it, and the computer's own sentence stays in both logs
   * (`browser-computer-failed` here, `computer-browser-open-failed` on the computer).
   */
  function refused(answer: { status: number; body: unknown }): Response {
    const said = (answer.body as { error?: unknown } | null)?.error;
    const sentence = typeof said === "string" && said ? said : null;
    if (answer.status === 503)
      return Response.json({ error: SENTENCES.notSetUp }, { status: 503 });
    if (answer.status === 400 || answer.status === 409)
      return Response.json(
        { error: sentence ?? SENTENCES.unreachable },
        { status: answer.status },
      );
    return Response.json(
      {
        error:
          answer.status >= 500 && sentence ? sentence : SENTENCES.unreachable,
      },
      { status: 502 },
    );
  }

  function unreachable(error: unknown): Response {
    return error instanceof BrowserCallError
      ? Response.json({ error: error.message }, { status: error.status })
      : Response.json({ error: SENTENCES.unreachable }, { status: 502 });
  }

  const closed = (computerId: string, available: boolean): BrowserApiState => ({
    available,
    computerId,
    open: false,
    tabs: [],
  });

  /**
   * The person's browser as they see it. The Recorder's report is taken as it says, except that a Recorder holding a
   * connection OpenBot revoked is signed out whatever it says: OpenBot tells it of a revoke at once
   * (`browserConnectionRevoked`), and when that did not reach it, it hears only on its next call to OpenBot. And its
   * narration is the window's, signed in or out (`asNarrated`).
   */
  const view = async (
    userId: string,
    state: BrowserState,
  ): Promise<BrowserApiState> => {
    const narration = narrationOf(state);
    const recorder = state.recorder;
    const revoked =
      recorder?.connected === true &&
      !(await holdsBrowserConnection(deps.recorder.connections, userId));
    const reported = recorder && revoked ? signedOut(recorder) : recorder;
    return {
      ...state,
      ...(reported
        ? {
            recorder: narration ? asNarrated(reported, narration) : reported,
          }
        : {}),
      available: true,
      computerId: personBrowserId(userId),
      ...(narration ? { narration } : {}),
    };
  };

  /** The browser as it is now, for the person to see. Never fails for the computer: a browser that cannot be asked is
   * one that is not open, and opening it says why. */
  async function currentState(userId: string): Promise<BrowserApiState> {
    const computerId = personBrowserId(userId);
    const computers = deps.computers;
    if (!computers) return closed(computerId, false);
    let state: BrowserState | null;
    try {
      if (!(await computers.running(computerId)))
        return closed(computerId, true);
      const base = await computers.locate(computerId);
      const answer = await ask(base, computerId, browserComputerPaths.state);
      state = answer.status === 200 ? browserState(answer.body) : null;
    } catch {
      return closed(computerId, true);
    }
    return state ? view(userId, state) : closed(computerId, true);
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
      return Response.json({ error: SENTENCES.unavailable }, { status: 503 });
    let taken: { status: number; body: unknown };
    try {
      const base = await computers.locate(computerId);
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
   * One at a time for each person. Each mints the browser a connection, which revokes the one the open before it minted,
   * and the Recorder asks OpenBot whether its connection stands before it takes it. Two opens side by side (the Browser
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

  /**
   * One open, `connect`'s turn. The connection is minted here and exchanged at once, as the Recorder's own exchange
   * would: the same store, the same checks, the sealed organization session carried from this request. Its install id
   * is the browser's, so this revokes the token the last one made, in the same transaction, rather than adding another.
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
    if (!computers) return refuse(SENTENCES.unavailable, 503);
    const openbotUrl = deps.openbotUrl(asker.origin);
    if (!openbotUrl) {
      console.warn(
        JSON.stringify({ type: "browser-open-no-address", error: NO_ADDRESS }),
      );
      return refuse(SENTENCES.notSetUp, 503);
    }

    const minted = await deps.recorder.connections.mintCode(
      actor.id,
      "openbot-browser",
      await deps.recorder.sealOrganizationSession(asker.cookie),
    );
    if (!minted) return refuse(SENTENCES.tooMany, 429);
    const made = await deps.recorder.connections.exchange({
      code: minted.code,
      label: OPENBOT_BROWSER_LABEL,
      extensionId: RECORDER_EXTENSION_ID,
      installId: personBrowserInstallId(computerId),
    });
    if (!made) return refuse(SENTENCES.notConnected, 500);
    await recorderConnected({
      made,
      audit,
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

    try {
      const base = await computers.locate(computerId);
      const answer = await ask(base, computerId, browserComputerPaths.open, {
        body: request.data,
        timeoutMs: OPEN_TIMEOUT_MS,
      });
      if (answer.status < 200 || answer.status >= 300)
        return { ok: false, response: refused(answer) };
      const state = browserState(answer.body);
      if (state?.browser && state.window) return { ok: true, state };
      // The computer answers its state; one that answered something else is asked for it.
      const asked = await ask(base, computerId, browserComputerPaths.state);
      return {
        ok: true,
        state: asked.status === 200 ? browserState(asked.body) : null,
      };
    } catch (error) {
      return { ok: false, response: unreachable(error) };
    }
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
    let state: BrowserState | null;
    try {
      const base = await computers.locate(computerId);
      const answer = await ask(base, computerId, browserComputerPaths.state);
      state = answer.status === 200 ? browserState(answer.body) : null;
    } catch (error) {
      return unreachable(error);
    }
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
    context.json(await currentState(context.var.actor.id)),
  );

  routes.post("/open", deps.requireUser, async (context) => {
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
    async (context, next) => {
      arrivals.set(context.req.raw, Date.now());
      await next();
    },
    deps.requireUser,
    jsonOnly,
    smallBody,
    async (context) => {
      const arrival = arrivals.get(context.req.raw) ?? Date.now();
      const body = await parsed(context.req.raw, browserNarrationRequestSchema);
      if (!body || ("text" in body && body.endedAt < body.startedAt))
        return context.json({ error: "That phrase was not complete." }, 400);
      const corrected = onServerClock(body, arrival);
      if (!corrected)
        return context.json({ error: SENTENCES.phraseTimes }, 400);
      return forward(
        context.var.actor.id,
        browserComputerPaths.narration,
        corrected,
        async () => ({ ok: true }),
      );
    },
  );

  routes.post(
    "/tabs",
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

  routes.post("/close", deps.requireUser, async (context) =>
    forward(context.var.actor.id, browserComputerPaths.close, {}),
  );

  return routes;
}
