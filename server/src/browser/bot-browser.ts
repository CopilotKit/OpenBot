import { createHash } from "node:crypto";
import {
  BOT_BROWSER_VIA,
  type BotBrowserApiState,
  type BotBrowserComputerClearRequest,
  type BotBrowserComputerRecordingRequest,
  type BotBrowserState,
  botBrowserComputerPaths,
  botBrowserComputerRecordingRequestSchema,
} from "@openbot/shared/bot-browser";
import type { ComputerControlState } from "@openbot/shared/computer-control";
import {
  browserNavigateRequestSchema,
  browserRecordingRequestSchema,
  browserTabsRequestSchema,
} from "@openbot/shared/openbot-browser";
import type { RecorderConnection } from "@openbot/shared/recorder-api";
import { RECORDER_EXTENSION_ID } from "@openbot/shared/recorder-extension";
import { Hono } from "hono";
import type { z } from "zod";
import type { AuditStore } from "../audit";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import type { ComputerSeat } from "../computer/computer-key";
import type { ComputerGateway } from "../computer/gateway";
import type { EgressPolicy } from "../computer/policy-network";
import { actorOf } from "../computer/routes";
import { reasonWithoutStatement } from "../db/query-failure";
import { recorderAudit, recorderConnected } from "../recorder/connected";
import type {
  BotBrowserRevokeReason,
  RecorderConnectionStore,
} from "../recorder/connections";
import type { RecorderExtensionDeps } from "../recorder/wiring";
import { recorderOriginRules, withRecorderOrigins } from "./egress";
import {
  BrowserCallError,
  browserState,
  CALL_BUDGET_MS,
  callFailed,
  computerCaller,
  computerRefusal,
  inBudget,
  isWebAddress,
  jsonOnly,
  narrationOnServerClock,
  OPEN_BUDGET_MS,
  requestSecondsFor,
  STATE_TIMEOUT_MS,
  smallBody,
  withBudget,
} from "./routes";

/*
 * A BOT'S BROWSER, WORKED BY A PERSON (shared/bot-browser.ts): the bar above a Bot's screen and Record, for whoever holds
 * the Bot's wheel. Every route here sits under the computer routes' own guard (computer/routes.ts), so a person who may
 * not use the Bot has had 404 before reaching any of it, and a person's own browser id never gets this far.
 *
 * THE RECORDER CONNECTION IS THE RECORDING PERSON'S, FOR ONE RECORDING. Record mints it for the caller, stored under an
 * install id the Bot's browser alone has (one live per Bot and person: the next replaces it), and hands it to the
 * computer with the start; Stop revokes it once the computer has stopped. A recording can also end without Stop (the
 * wheel went back, the browser restarted, the computer stopped), and then nobody told this server: its connection is
 * left behind, and is revoked the next time the server reads this Bot's browser, mints another for it, or hands its wheel
 * back to the Bot. Each is in Settings, Browsers while it lives, named for the Bot, and can be disconnected there.
 *
 * THE BOT'S NETWORK FOLLOWS THE CONNECTIONS. While one is live the Bot's computer is pushed its policy with OpenBot's and
 * the gateway's origins let through (`botBrowserNetwork`), which the Recorder needs and the Bot does not. The Bot cannot
 * act while a person holds its wheel, and after a person has held it the Bot acts again only once that person hands it
 * back through these routes (a restart or a stop leaves the computer waiting for a person: agent-computer's control.ts),
 * which revokes every connection and pushes the Bot its own policy. So the Bot never acts with the Recorder's way out.
 */

/** What the person is told. Never a computer's setup sentence, and never "read the logs". */
const SENTENCES = {
  unreachable: "The Bot's browser could not be reached. Try again.",
  slow: "The Bot's browser is taking too long to answer. The page may still be loading.",
  notSetUp:
    "The Bot's browser can't do that right now. Ask an admin to check OpenBot's setup.",
  notSetUpSingleUser:
    "The Bot's browser can't do that right now. Quit OpenBot, open it again, and try once more.",
  takeControl: "Take control of the Bot's browser first.",
  alreadyRecording: "A recording is already running in this Bot's browser.",
  nothingRecording: "Nothing is being recorded in this Bot's browser.",
  someoneElses:
    "Someone else is recording in this Bot's browser, so only they can do that.",
  tooMany:
    "Too many recordings were started at once. Wait a few minutes and try again.",
  notConnected: "The Recorder could not be connected. Try again.",
  noPerson: "This person could not be found. Try again.",
  notWeb: "Only web addresses open here.",
  /** The profile is gone, and what goes with it on this side (its row, its snapshots and screenshots) did not all go. */
  clearedNotFinished:
    "The Bot's browser was cleared, but OpenBot couldn't finish. Clear it again.",
} as const;

/** Why a recording cannot start when this OpenBot has no address the Recorder would take: for the log, as for the
 * person's own browser (browser/routes.ts). */
const NO_ADDRESS =
  "This OpenBot has no address a browser can reach it at, so the Recorder in a Bot's browser cannot be connected. Set OPENBOT_PUBLIC_URL to this OpenBot's https address.";

/** The computer's own route for who holds the wheel (`ComputerControlState`). */
const CONTROL_PATH = "/control";

/*
 * HOW LONG EACH ROUTE HAS TO ANSWER, from the request's arrival, as the person's own browser's routes have
 * (browser/routes.ts): every wait in it shares the budget (finding the computer, each call to it, a policy push), and
 * OpenBot's server keeps the request open for it (`botBrowserRequestSeconds`), past the 10 s after which `Bun.serve`
 * closes a request that has sent nothing and the person gets an empty reply.
 *
 * - The read, which the Bot's screen makes every second: the computer's word on the wheel and the browser, within
 *   STATE_TIMEOUT_MS all told, and Bun's own 10 s kept. A browser that does not answer in it is said to be slow (504),
 *   and the screen keeps showing what it last read.
 * - Record and Stop: a start connects the Recorder and records (up to START_TIMEOUT_MS), and Stop waits on the computer
 *   for the last of the recording to reach Intelligence before it disconnects the Recorder.
 * - The bar and narration: the computer's own wait for a page.
 * - Clear: a recording there ends and the last of it is waited for, the browser closes and its profile goes, and it
 *   starts again (up to CLEAR_TIMEOUT_MS on the computer).
 */
const READ_BUDGET_MS = STATE_TIMEOUT_MS;
const RECORDING_BUDGET_MS = OPEN_BUDGET_MS;
const BAR_BUDGET_MS = CALL_BUDGET_MS;
const CLEAR_BUDGET_MS = OPEN_BUDGET_MS;

/** A Bot's browser's routes under the computer routes (`/api/computers/:botId/browser/...`), for the server's timeout. */
const BOT_BROWSER_ROUTE =
  /^\/api\/computers\/[^/]+\/browser\/(recording|tabs|navigate|narration|clear)$/;

/**
 * The computer routes that end a recording in the Bot's browser on the way (computer/routes.ts): a hand-back and a
 * cancel answer once the recording has ended and the last of it is sent (up to the computer's 20 s send wait), and a
 * stop or a reset close the browser, which ends it the same way. Each is one call to the computer, as the bar's are.
 */
const ENDS_A_RECORDING_ROUTE =
  /^\/api\/computers\/[^/]+\/(control\/release|control\/cancel|computers\/stop|computers\/reset)$/;

/**
 * How long OpenBot's server keeps a request to a Bot's browser's routes open, in seconds (http-server.ts applies it), or
 * undefined for any other path, and for the read, which answers within its budget and keeps Bun's own 10 s. The
 * computer routes that end a recording on the way are kept open as long as the bar's, past the 10 s after which Bun
 * would close them and the person would be told a hand-back that happened had failed.
 */
export function botBrowserRequestSeconds(pathname: string): number | undefined {
  if (ENDS_A_RECORDING_ROUTE.test(pathname))
    return requestSecondsFor(BAR_BUDGET_MS);
  const route = BOT_BROWSER_ROUTE.exec(pathname)?.[1];
  if (!route) return undefined;
  return requestSecondsFor(
    route === "recording"
      ? RECORDING_BUDGET_MS
      : route === "clear"
        ? CLEAR_BUDGET_MS
        : BAR_BUDGET_MS,
  );
}
/**
 * How long the computer may take to start a recording: the Recorder is connected, asks OpenBot whether its connection
 * stands, and starts. The person's own browser gives an open (which does the same and launches a browser) as long.
 */
const START_TIMEOUT_MS = 90_000;
/**
 * How long the computer may take to stop a recording: the Recorder stops, the last of the recording is waited for (the
 * computer's SENDING_WAIT_MS, 20 s), and the Recorder is disconnected. Past the 45 s every other call has, so a slow
 * Recorder still answers and its connection goes at once, rather than waiting to be found left behind.
 */
const STOP_TIMEOUT_MS = 90_000;
/**
 * How old a connection must be before a reader may call it left behind while its person still holds the wheel: past
 * any start still under way. Younger, the computer may simply not have started the recording it was minted for yet.
 */
const START_GRACE_MS = START_TIMEOUT_MS + 30_000;
/**
 * How long the computer may take to clear a Bot's browser: a recording there ended and the last of it waited for (the
 * computer's SENDING_WAIT_MS, 20 s), the browser closed and given 2 s to finish writing, its profile deleted, and the
 * browser started again, which a cold start takes seconds to do.
 */
const CLEAR_TIMEOUT_MS = 90_000;
/** The longest a connection's label may be: what a Recorder may name itself when it connects (shared/recorder-api.ts). */
const LABEL_CHARS = 80;

/**
 * The install id a Bot's browser's Recorder connections are stored under, for every person who records there: 32 hex
 * digits, the shape every install id has, derived from the Bot alone so every replica finds the same one. A person's
 * next connection for this Bot replaces their last (the store's own rule), and the Bot's browser is asked about as one.
 */
export function botBrowserInstallId(botId: string): string {
  return createHash("sha256")
    .update(`${BOT_BROWSER_VIA}:${botId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The live Recorder connections this Bot's browser holds, one for each person recording there (or left behind).
 *
 * A Bot has a browser on every computer it runs on: its own when it is isolated, one on each person's computer
 * otherwise (computer/computer-key.ts). Its connections are filed under the Bot (`botBrowserInstallId`), so on a
 * person's computer only that person's are this browser's: another person's are for the same Bot's browser on their
 * own computer, which this browser's reads, hand-backs and clears must never end. A seat on the Bot's own computer
 * holds everyone's.
 */
async function heldConnections(
  connections: Pick<RecorderConnectionStore, "atInstall">,
  where: string | Pick<ComputerSeat, "botId" | "key">,
) {
  const botId = typeof where === "string" ? where : where.botId;
  const held = await connections.atInstall(
    botBrowserInstallId(botId),
    BOT_BROWSER_VIA,
  );
  if (typeof where === "string" || where.key.kind !== "person") return held;
  const person = where.key.personId;
  return held.filter((connection) => connection.userId === person);
}

/**
 * A Bot's network policy as it must be now (admin/controls.ts `duringRecording`): its own, with OpenBot's and the
 * Intelligence gateway's origins let through while its browser holds a Recorder connection, which is from Record until
 * the recording is stopped or found left behind. Read from the database, so every replica's push says the same, the
 * periodic one included, and a recording started through one server is not cut off by another's push.
 */
export function botBrowserNetwork(input: {
  connections: Pick<RecorderConnectionStore, "atInstall">;
  /** This OpenBot's addresses (its public URL and its app's). */
  openbotUrls: readonly (string | undefined)[];
  /** INTELLIGENCE_GATEWAY_WS_URL. */
  gatewayUrl: string;
}): (botId: string, policy: EgressPolicy) => Promise<EgressPolicy> {
  const rules = recorderOriginRules(input);
  return async (botId, policy) =>
    (await heldConnections(input.connections, botId)).length > 0
      ? withRecorderOrigins(policy, rules)
      : policy;
}

export type BotBrowserRouteDeps = {
  /** Where the Bot's computer is, and whether it is up, without starting it; and what follows a clear on this side. */
  gateway: Pick<
    ComputerGateway,
    "locate" | "status" | "browserCleared" | "seatFor" | "addressOf"
  >;
  /** The computer token, the same one every computer requires. */
  token?: string;
  /** The Recorder's connections and what goes with them (recorder/wiring.ts). */
  recorder: Pick<
    RecorderExtensionDeps,
    "connections" | "user" | "sealOrganizationSession" | "onConnected"
  >;
  /** The address the Recorder reaches this OpenBot at (browser/address.ts), from the request's Origin. */
  openbotUrl: (requestOrigin: string | undefined) => string | null;
  /**
   * Pushes the Bot's computer its network policy now (computer/policy-network.ts `policyPusher`), which
   * `botBrowserNetwork` widens while a connection is live. Absent where no network policy is pushed at all.
   */
  pushPolicy?: (seat: ComputerSeat) => Promise<void>;
  /** The Bot's name as this person sees it, for the connection's name in Settings, Browsers. */
  botName?: (
    actor: AuthenticatedActor,
    botId: string,
  ) => Promise<string | null>;
  auditStore?: AuditStore;
  fetchImpl?: typeof fetch;
  /** How long a call to the computer may take, other than a start's. A test's own, shorter. */
  callTimeoutMs?: number;
  /** Each route's budget (READ_BUDGET_MS, RECORDING_BUDGET_MS, BAR_BUDGET_MS, CLEAR_BUDGET_MS): a test's own, shorter. */
  budgetMs?: {
    read?: number;
    recording?: number;
    bar?: number;
    clear?: number;
  };
  /** A single-user OpenBot: the one person is its admin, so a setup failure is theirs to see to. */
  singleUser?: boolean;
  /**
   * Why Record is refused in every Bot's browser here (browser/host.ts `botRecordRefusal`): its Bots share one computer.
   * Absent where each Bot has a computer of its own.
   */
  recordRefused?: string;
};

export type BotBrowser = {
  /** The routes, mounted at `/:botId/browser` under the computer routes' guard. */
  routes: Hono<{ Variables: AppVariables }>;
  /**
   * The wheel went back to the Bot through OpenBot (a hand back, or the Bot's request cancelled): any recording in its
   * browser has ended, so every connection it holds is left behind. Revoked, and the Bot pushed its own policy, before
   * the Bot acts again. Never throws.
   */
  wheelReturned(seat: ComputerSeat): Promise<void>;
  /**
   * A hand-back or a cancel whose answer did not arrive: it may have happened all the same. The computer is asked who
   * holds the wheel now, and every connection no recording there can be using is revoked, as a read of the Bot's screen
   * would. Never throws.
   */
  wheelMayHaveReturned(seat: ComputerSeat): Promise<void>;
};

/** The person holding the Bot's wheel, or null while the Bot holds it or nobody said who took it. */
function heldBy(control: ComputerControlState | null): string | null {
  return control?.holder === "human" && control.heldBy ? control.heldBy : null;
}

/** What the Bot's computer said, when it was asked. Both null when it is not up or did not answer. */
type Seen = {
  control: ComputerControlState | null;
  state: BotBrowserState | null;
  /** The computer is up, so pushing it a policy starts nothing. */
  running: boolean;
  /**
   * Whether this is the computer's word on what records there: it answered for the wheel and its browser both, or there
   * is no computer running at all, so nothing records. One that could not be asked, or is between states (a readiness
   * check can flap under a recording), says nothing, and nothing is decided from it.
   */
  known: boolean;
  /** The computer, or the Bot's browser on it, did not answer within the request's budget. */
  slow?: boolean;
};

/** A wait that ran out: the computer's call timed out, or the request's budget was spent. */
const ranOut = (error: unknown) =>
  error instanceof BrowserCallError && error.status === 504;

const CLOSED: BotBrowserState = { open: false, tabs: [] };

/** A Bot's browser as one person sees it: whether the wheel and the recording are theirs, and of somebody else's
 * recording only that one is running, never its count of steps or its microphone. The last recording stopped there is
 * shown only to the person it was: its title and counts are theirs, and on a shared Bot the next person to open the
 * screen must not read them. */
function viewFor(
  userId: string,
  control: ComputerControlState | null,
  state: BotBrowserState | null,
  recordRefused?: string,
): BotBrowserApiState {
  const { recorder: report, lastStoppedBy, ...shown } = state ?? CLOSED;
  const recordingIsMine = shown.recordingBy === userId;
  const lastIsMine = lastStoppedBy === userId;
  let recorder = report;
  if (report) {
    const {
      userId: connected,
      connectionId,
      recordingId,
      title,
      startedAt,
      lastStopped,
      actions,
      voice,
      ...common
    } = report;
    const shownToThem = recordingIsMine || !shown.recordingBy;
    recorder = {
      ...common,
      // Another person's recording is only running: how many steps it holds, and whether they are talking, are theirs.
      actions: shownToThem ? actions : 0,
      ...(shownToThem
        ? {
            ...(connected ? { userId: connected } : {}),
            ...(connectionId ? { connectionId } : {}),
            ...(recordingId ? { recordingId } : {}),
            ...(title ? { title } : {}),
            ...(startedAt ? { startedAt } : {}),
            ...(voice ? { voice } : {}),
          }
        : {}),
      ...(lastIsMine && lastStopped ? { lastStopped } : {}),
    };
  }
  return {
    ...shown,
    ...(recorder ? { recorder } : {}),
    ...(lastIsMine ? { lastStoppedBy } : {}),
    mine: heldBy(control) === userId,
    recordingIsMine,
    ...(recordRefused ? { recordRefused } : {}),
  };
}

/** The connection's name in Settings, Browsers: the Bot's browser, by the Bot's name. */
function labelFor(name: string | null): string {
  const suffix = "'s browser";
  const bot = name?.trim();
  return bot
    ? `${bot.slice(0, LABEL_CHARS - suffix.length)}${suffix}`
    : "A Bot's browser";
}

export function createBotBrowser(deps: BotBrowserRouteDeps): BotBrowser {
  const routes = new Hono<{ Variables: AppVariables }>();
  const audit = recorderAudit(deps.auditStore);
  const ask = computerCaller(deps, {
    slow: SENTENCES.slow,
    unreachable: SENTENCES.unreachable,
  });
  const connections = deps.recorder.connections;
  const notSetUp = deps.singleUser
    ? SENTENCES.notSetUpSingleUser
    : SENTENCES.notSetUp;
  const refused = (answer: { status: number; body: unknown }) =>
    computerRefusal(answer, { notSetUp, unreachable: SENTENCES.unreachable });
  const failed = (error: unknown) => callFailed(error, SENTENCES.unreachable);
  const conflict = (error: string) => Response.json({ error }, { status: 409 });
  const tooSlow = () =>
    Response.json({ error: SENTENCES.slow }, { status: 504 });
  /** Whether the Bot's computer is up, and where it is: each within what is left of the request's budget. */
  const statusOf = (seat: ComputerSeat) =>
    inBudget(deps.gateway.status(seat), "status", SENTENCES.slow);
  const where = (seat: ComputerSeat) =>
    inBudget(deps.gateway.locate(seat), "locate", SENTENCES.slow);
  /** The Bot's seat for the person asking: their own computer's, or the Bot's own computer when it is isolated. */
  const seatFor = (botId: string, actor: { id: string }) =>
    deps.gateway.seatFor(botId, actor.id);
  const readBudget = withBudget(deps.budgetMs?.read ?? READ_BUDGET_MS);
  const recordingBudget = withBudget(
    deps.budgetMs?.recording ?? RECORDING_BUDGET_MS,
  );
  const barBudget = withBudget(deps.budgetMs?.bar ?? BAR_BUDGET_MS);
  const clearBudget = withBudget(deps.budgetMs?.clear ?? CLEAR_BUDGET_MS);

  /** The Bot's browser state as the computer reported it, checked for the two fields every answer has. */
  const stateOf = (value: unknown) =>
    browserState(value) as BotBrowserState | null;

  /**
   * Who holds the wheel and what the Bot's browser is doing, from the computer at `base`, each within
   * STATE_TIMEOUT_MS (a browser that answers at all answers in milliseconds) and the request's budget. Null for what it
   * did not answer; `slow` when that was for want of time.
   */
  async function report(
    base: string,
    seat: ComputerSeat,
  ): Promise<Pick<Seen, "control" | "state" | "slow">> {
    let slow = false;
    const unanswered = (error: unknown) => {
      if (ranOut(error)) slow = true;
      return null;
    };
    const [control, state] = await Promise.all([
      ask(base, deps.gateway.addressOf(seat), CONTROL_PATH, {
        timeoutMs: STATE_TIMEOUT_MS,
      }).then(
        (answer) =>
          answer.status === 200 ? (answer.body as ComputerControlState) : null,
        unanswered,
      ),
      ask(base, deps.gateway.addressOf(seat), botBrowserComputerPaths.state, {
        timeoutMs: STATE_TIMEOUT_MS,
      }).then(
        (answer) => (answer.status === 200 ? stateOf(answer.body) : null),
        unanswered,
      ),
    ]);
    return { control, state, ...(slow ? { slow } : {}) };
  }

  /** What a running computer said, as seen. */
  const answered = (said: Pick<Seen, "control" | "state" | "slow">): Seen => ({
    ...said,
    running: true,
    known: said.control !== null && said.state !== null,
  });

  /** What the Bot's computer says now, when it is up. Asking never starts it: the screen asks every few seconds, and
   * looking is not a reason to wake a computer (the screenshot route's rule, computer/routes.ts). */
  async function look(seat: ComputerSeat): Promise<Seen> {
    const unknown = { control: null, state: null, running: false };
    try {
      const { state } = await statusOf(seat);
      if (state === "absent") return { ...unknown, known: true };
      if (state !== "ready") return { ...unknown, known: false };
      return answered(await report(await where(seat), seat));
    } catch (error) {
      return {
        ...unknown,
        known: false,
        ...(ranOut(error) ? { slow: true } : {}),
      };
    }
  }

  /** Pushes the Bot its policy as the connections now say. Logged, never thrown: a recording or a read goes on, and the
   * periodic push sends the same policy within the minute. */
  async function pushPolicy(seat: ComputerSeat, why: string) {
    const botId = seat.botId;
    if (!deps.pushPolicy) return;
    try {
      // Within the request's budget: a push that takes longer goes on without it, and is logged if it fails.
      await inBudget(deps.pushPolicy(seat), "egress-policy", SENTENCES.slow);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "bot-browser-policy-push-failed",
          botId,
          why,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Ends one of this Bot's browser's connections, with its `recorder.revoked` row in the same transaction
   * (recorder/connections.ts). Never throws: when the row cannot be written the connection stands, and is ended as one
   * left behind the next time this Bot's browser is read, minted for or handed back, while what the person asked for
   * (a Stop the computer has done) is answered as done.
   */
  async function revoke(
    connection: RecorderConnection & { userId: string },
    reason: BotBrowserRevokeReason,
  ) {
    try {
      await connections.revoke(connection.userId, connection.id, reason);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-browser-revoke-failed",
          reason,
          // A failed query's message carries the values bound to it: never logged.
          error: reasonWithoutStatement(error),
        }),
      );
    }
  }

  /**
   * Revokes the connections this Bot's browser holds that no recording can be using: every one but the running
   * recording's, and but a connection minted so lately that the recording it is for may still be starting, for a person
   * who holds the wheel (only they can start one). With no computer running, only age says a connection is left behind.
   * `keep` is a connection minted this moment. Nothing is decided from a computer that could not say. The Bot is pushed
   * its narrowed policy when the computer is up; one that is not is pushed it when it wakes. Never throws: a read is
   * answered whatever happened here.
   */
  async function settle(seat: ComputerSeat, seen: Seen, keep?: string) {
    const botId = seat.botId;
    if (!seen.known) return;
    try {
      const holder = heldBy(seen.control);
      const now = Date.now();
      const leftBehind = (await heldConnections(connections, seat)).filter(
        (connection) =>
          connection.id !== keep &&
          connection.userId !== seen.state?.recordingBy &&
          ((seen.control !== null && connection.userId !== holder) ||
            now - Date.parse(connection.createdAt) > START_GRACE_MS),
      );
      if (leftBehind.length === 0) return;
      for (const connection of leftBehind) await revoke(connection, "ended");
      if (seen.running) await pushPolicy(seat, "left-behind");
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-browser-settle-failed",
          botId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** The body, read against the contract's schema; null when it does not match. */
  async function parsed<T extends z.ZodType>(
    request: Request,
    schema: T,
  ): Promise<z.infer<T> | null> {
    const body = schema.safeParse(await request.json().catch(() => null));
    return body.success ? body.data : null;
  }

  /**
   * The Bot's computer and what it says, for a caller who must hold the wheel: or what they are told instead. Asked of
   * the computer each time rather than remembered, since the wheel moves on the computer, and refused here rather than
   * left to it: the computer knows a person holds the wheel, and only this server knows which person is asking.
   */
  async function withTheWheel(
    seat: ComputerSeat,
    userId: string,
  ): Promise<
    | ({ ok: true; base: string } & Pick<Seen, "control" | "state">)
    | { ok: false; response: Response }
  > {
    let base: string;
    try {
      if ((await statusOf(seat)).state !== "ready")
        return { ok: false, response: conflict(SENTENCES.takeControl) };
      base = await where(seat);
    } catch (error) {
      return { ok: false, response: failed(error) };
    }
    const seen = await report(base, seat);
    // Not said to be another's wheel when the computer only did not answer in time.
    if (seen.slow && heldBy(seen.control) !== userId)
      return { ok: false, response: tooSlow() };
    if (heldBy(seen.control) !== userId)
      return { ok: false, response: conflict(SENTENCES.takeControl) };
    return { ok: true, base, ...seen };
  }

  /** One request the bar makes, for the person at the wheel: answered with the Bot's browser after it. */
  async function drive(
    seat: ComputerSeat,
    userId: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const wheel = await withTheWheel(seat, userId);
    if (!wheel.ok) return wheel.response;
    let taken: { status: number; body: unknown };
    try {
      taken = await ask(wheel.base, deps.gateway.addressOf(seat), path, {
        body,
      });
    } catch (error) {
      return failed(error);
    }
    if (taken.status < 200 || taken.status >= 300) return refused(taken);
    return Response.json(
      viewFor(
        userId,
        wheel.control,
        stateOf(taken.body) ?? wheel.state,
        deps.recordRefused,
      ),
    );
  }

  /** Each Bot's start in progress, which the next one waits for: two starts side by side would each mint a connection
   * and the second would revoke the one the first was handing over. The computer refuses a second recording besides. */
  const starting = new Map<string, Promise<void>>();

  function start(
    seat: ComputerSeat,
    asker: { actor: AuthenticatedActor; origin?: string; cookie?: string },
    request: { title: string; language?: string },
  ): Promise<Response> {
    const botId = seat.botId;
    const run = (starting.get(botId) ?? Promise.resolve()).then(() =>
      startNow(seat, asker, request),
    );
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    starting.set(botId, settled);
    void settled.then(() => {
      if (starting.get(botId) === settled) starting.delete(botId);
    });
    return run;
  }

  /**
   * Record: for the person at the wheel, while nothing records. Their connection is minted and exchanged at once, as the
   * person's own browser's is (browser/routes.ts), under the Bot's browser's install id, which replaces their last one
   * for this Bot; anybody else's this Bot's browser still holds is left behind and goes. The Bot is pushed its widened
   * policy before the computer connects the Recorder, which asks OpenBot whether its connection stands as it takes it.
   * A start the computer refused takes its connection and the widening away again.
   */
  async function startNow(
    seat: ComputerSeat,
    asker: { actor: AuthenticatedActor; origin?: string; cookie?: string },
    request: { title: string; language?: string },
  ): Promise<Response> {
    const botId = seat.botId;
    const { actor } = asker;
    // Before the wheel or the computer is asked, and long before a connection is minted for a profile others can read.
    if (deps.recordRefused)
      return Response.json({ error: deps.recordRefused }, { status: 403 });
    const wheel = await withTheWheel(seat, actor.id);
    if (!wheel.ok) return wheel.response;
    // Whether something records there already is the computer's to say: a start on a guess could replace the
    // connection of the person's own recording that is running.
    if (!wheel.state)
      return Response.json({ error: SENTENCES.unreachable }, { status: 502 });
    if (wheel.state.recordingBy)
      return conflict(
        wheel.state.recordingBy === actor.id
          ? SENTENCES.alreadyRecording
          : SENTENCES.someoneElses,
      );
    const openbotUrl = deps.openbotUrl(asker.origin);
    if (!openbotUrl) {
      console.warn(
        JSON.stringify({
          type: "bot-browser-record-no-address",
          error: NO_ADDRESS,
        }),
      );
      return Response.json({ error: notSetUp }, { status: 503 });
    }

    const minted = await connections.mintCode(
      actor.id,
      BOT_BROWSER_VIA,
      await deps.recorder.sealOrganizationSession(asker.cookie),
    );
    if (!minted) {
      // The same refusal, and the same row, as the connect-code route's (recorder/routes.ts).
      await audit({
        eventType: "recorder.connect_refused",
        targetType: "recorder_connection",
        actorUserId: actor.id,
        payload: { reason: "too_many_codes", via: BOT_BROWSER_VIA },
      });
      return Response.json({ error: SENTENCES.tooMany }, { status: 429 });
    }
    const label = labelFor(
      (await deps.botName?.(actor, botId).catch(() => null)) ?? null,
    );
    let made: Awaited<ReturnType<RecorderConnectionStore["exchange"]>>;
    try {
      made = await connections.exchange({
        code: minted.code,
        label,
        extensionId: RECORDER_EXTENSION_ID,
        installId: botBrowserInstallId(botId),
      });
    } catch (error) {
      // The connection and its row are written together (recorder/connections.ts), so neither was.
      console.error(
        JSON.stringify({
          type: "bot-browser-connect-failed",
          botId,
          error: reasonWithoutStatement(error),
        }),
      );
      return Response.json({ error: SENTENCES.notConnected }, { status: 500 });
    }
    if (!made)
      return Response.json({ error: SENTENCES.notConnected }, { status: 500 });
    recorderConnected({
      userId: made.userId,
      onConnected: deps.recorder.onConnected,
    });
    const mine = { ...made.connection, userId: actor.id };
    /** The start did not happen: its connection goes, and with it the Bot's wider policy. */
    const unmade = async (response: Response) => {
      await revoke(mine, "not-started");
      await pushPolicy(seat, "not-started");
      return response;
    };
    const user = await deps.recorder.user(actor.id);
    if (!user)
      return unmade(
        Response.json({ error: SENTENCES.noPerson }, { status: 500 }),
      );
    const body = botBrowserComputerRecordingRequestSchema.safeParse({
      action: "start",
      title: request.title,
      ...(request.language ? { language: request.language } : {}),
      by: actor.id,
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
    } satisfies BotBrowserComputerRecordingRequest);
    if (!body.success)
      return unmade(
        Response.json({ error: SENTENCES.notConnected }, { status: 500 }),
      );

    await settle(seat, answered(wheel), made.connection.id);
    await pushPolicy(seat, "recording");
    let answer: { status: number; body: unknown };
    try {
      answer = await ask(
        wheel.base,
        deps.gateway.addressOf(seat),
        botBrowserComputerPaths.recording,
        {
          body: body.data,
          timeoutMs: START_TIMEOUT_MS,
        },
      );
    } catch (error) {
      return unmade(failed(error));
    }
    if (answer.status < 200 || answer.status >= 300)
      return unmade(refused(answer));
    return Response.json(
      viewFor(
        actor.id,
        wheel.control,
        stateOf(answer.body) ?? wheel.state,
        deps.recordRefused,
      ),
    );
  }

  /**
   * Stop: only the recording person's, and only while it runs. Once the computer has stopped it (or says nothing is
   * recording after all), every connection of theirs for this Bot is revoked and the Bot pushed its own policy again.
   * One the computer could not be asked to stop is left alone: the recording may still be running under it.
   */
  async function stop(seat: ComputerSeat, userId: string): Promise<Response> {
    let base: string;
    try {
      // A computer that is not there is recording nothing, and is not started to say so.
      const { state } = await statusOf(seat);
      if (state === "absent") {
        await settle(seat, {
          control: null,
          state: null,
          running: false,
          known: true,
        });
        return conflict(SENTENCES.nothingRecording);
      }
      if (state !== "ready")
        return Response.json({ error: SENTENCES.unreachable }, { status: 502 });
      base = await where(seat);
    } catch (error) {
      return failed(error);
    }
    const seen = answered(await report(base, seat));
    if (!seen.state)
      return seen.slow
        ? tooSlow()
        : Response.json({ error: SENTENCES.unreachable }, { status: 502 });
    const recordingBy = seen.state.recordingBy;
    if (recordingBy !== userId) {
      await settle(seat, seen);
      return conflict(
        recordingBy ? SENTENCES.someoneElses : SENTENCES.nothingRecording,
      );
    }
    let answer: { status: number; body: unknown };
    try {
      answer = await ask(
        base,
        deps.gateway.addressOf(seat),
        botBrowserComputerPaths.recording,
        {
          body: { action: "stop" } satisfies BotBrowserComputerRecordingRequest,
          timeoutMs: STOP_TIMEOUT_MS,
        },
      );
    } catch (error) {
      return failed(error);
    }
    const ended = answer.status >= 200 && answer.status < 300;
    if (ended || answer.status === 409) {
      for (const connection of await heldConnections(connections, seat))
        if (connection.userId === userId) await revoke(connection, "stopped");
      await pushPolicy(seat, "stopped");
    }
    if (!ended) return refused(answer);
    return Response.json(
      viewFor(
        userId,
        seen.control,
        stateOf(answer.body) ?? seen.state,
        deps.recordRefused,
      ),
    );
  }

  /**
   * Clear the Bot's browser (shared/bot-browser.ts, CLEARING A BROWSER): for the person holding the wheel, as the bar
   * is, so it is never wiped under the Bot mid-task. The computer ends a recording there first, wipes the profile and
   * starts the browser again, fresh, under them; then, past the point of no return, the row is written and the
   * snapshots and screenshots kept of its pages go, as a reset's do (`browserCleared`). A recording the clear ended
   * leaves its connection behind, which goes now, and the Bot is pushed its own policy again.
   */
  async function clear(
    seat: ComputerSeat,
    actor: AuthenticatedActor,
  ): Promise<Response> {
    const botId = seat.botId;
    const wheel = await withTheWheel(seat, actor.id);
    if (!wheel.ok) return wheel.response;
    let answer: { status: number; body: unknown };
    try {
      answer = await ask(
        wheel.base,
        deps.gateway.addressOf(seat),
        botBrowserComputerPaths.clear,
        {
          body: { by: actor.id } satisfies BotBrowserComputerClearRequest,
          timeoutMs: CLEAR_TIMEOUT_MS,
        },
      );
    } catch (error) {
      return failed(error);
    }
    if (answer.status < 200 || answer.status >= 300) return refused(answer);
    try {
      await deps.gateway.browserCleared(seat, actorOf(actor));
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-browser-cleared-not-recorded",
          botId,
          // A failed query's message carries the values bound to it: never logged.
          error: reasonWithoutStatement(error),
        }),
      );
      return Response.json(
        { error: SENTENCES.clearedNotFinished },
        { status: 500 },
      );
    }
    const held = await heldConnections(connections, seat).catch(() => []);
    for (const connection of held) await revoke(connection, "ended");
    if (held.length > 0) await pushPolicy(seat, "cleared");
    return Response.json(
      viewFor(
        actor.id,
        wheel.control,
        stateOf(answer.body) ?? CLOSED,
        deps.recordRefused,
      ),
    );
  }

  routes.get("/", readBudget, async (context) => {
    const seat = await seatFor(
      context.req.param("botId") ?? "",
      context.var.actor,
    );
    const seen = await look(seat);
    // Said, rather than read as a closed browser: the screen keeps what it last showed, and asks again in a second.
    if (seen.slow) return tooSlow();
    await settle(seat, seen);
    return context.json(
      viewFor(
        context.var.actor.id,
        seen.control,
        seen.state,
        deps.recordRefused,
      ),
    );
  });

  routes.post("/tabs", barBudget, jsonOnly, smallBody, async (context) => {
    const body = await parsed(context.req.raw, browserTabsRequestSchema);
    if (!body)
      return context.json({ error: "That tab could not be found." }, 400);
    if (body.action === "new" && body.url && !isWebAddress(body.url))
      return context.json({ error: SENTENCES.notWeb }, 400);
    return drive(
      await seatFor(context.req.param("botId") ?? "", context.var.actor),
      context.var.actor.id,
      botBrowserComputerPaths.tabs,
      body,
    );
  });

  routes.post("/navigate", barBudget, jsonOnly, smallBody, async (context) => {
    const body = await parsed(context.req.raw, browserNavigateRequestSchema);
    if (!body) return context.json({ error: "Type an address." }, 400);
    if ("url" in body && !isWebAddress(body.url))
      return context.json({ error: SENTENCES.notWeb }, 400);
    return drive(
      await seatFor(context.req.param("botId") ?? "", context.var.actor),
      context.var.actor.id,
      botBrowserComputerPaths.navigate,
      body,
    );
  });

  routes.post(
    "/recording",
    recordingBudget,
    jsonOnly,
    smallBody,
    async (context) => {
      const body = await parsed(context.req.raw, browserRecordingRequestSchema);
      if (!body)
        return context.json({ error: "Name what you are about to do." }, 400);
      const seat = await seatFor(
        context.req.param("botId") ?? "",
        context.var.actor,
      );
      if (body.action === "stop") return stop(seat, context.var.actor.id);
      return start(
        seat,
        {
          actor: context.var.actor,
          origin: context.req.header("origin"),
          cookie: context.req.header("cookie"),
        },
        body,
      );
    },
  );

  // Answered with nothing more than that it was taken, as for the person's own browser: a phrase comes every few
  // seconds while the person talks, and the page reads the state on its own. Its arrival was noted ahead of the computer
  // routes' guard (computer/routes.ts), so the time is the request's, not the end of signing the person in.
  routes.post("/narration", barBudget, jsonOnly, smallBody, async (context) => {
    const read = await narrationOnServerClock(context.req.raw);
    if (!read.ok) return context.json({ error: read.error }, 400);
    const seat = await seatFor(
      context.req.param("botId") ?? "",
      context.var.actor,
    );
    const userId = context.var.actor.id;
    let base: string;
    try {
      base = await where(seat);
    } catch (error) {
      return failed(error);
    }
    const { state, slow } = await report(base, seat);
    if (!state && slow) return tooSlow();
    if (state?.recordingBy !== userId)
      return context.json(
        {
          error: state?.recordingBy
            ? SENTENCES.someoneElses
            : SENTENCES.nothingRecording,
        },
        409,
      );
    let taken: { status: number; body: unknown };
    try {
      taken = await ask(
        base,
        deps.gateway.addressOf(seat),
        botBrowserComputerPaths.narration,
        {
          body: read.narration,
        },
      );
    } catch (error) {
      return failed(error);
    }
    if (taken.status < 200 || taken.status >= 300) return refused(taken);
    return context.json({ ok: true });
  });

  routes.post("/clear", clearBudget, async (context) =>
    clear(
      await seatFor(context.req.param("botId") ?? "", context.var.actor),
      context.var.actor,
    ),
  );

  return {
    routes,
    async wheelReturned(seat) {
      try {
        const held = await heldConnections(connections, seat);
        if (held.length === 0) return;
        for (const connection of held) await revoke(connection, "ended");
        await pushPolicy(seat, "wheel-returned");
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "bot-browser-settle-failed",
            botId: seat.botId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    },
    async wheelMayHaveReturned(seat) {
      await settle(seat, await look(seat));
    },
  };
}
