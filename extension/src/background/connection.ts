import {
  type ExchangeResponse,
  type RecorderMe,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import {
  RECORDER_CONNECT_STATUS,
  type TrustedConnectRule,
} from "@openbot/shared/recorder-page";
import type {
  ExternalResponse,
  ExternalToBackground,
  PageResponse,
  PageToBackground,
} from "../protocol/messages";
import { defaultBrowserName } from "../shared/browser-name";
import { OpenBotError, openbotJson } from "../shared/openbot-client";
import { normaliseOpenBotOrigin } from "../shared/origin";
import {
  allowsOpenBot,
  onPolicyChanged,
  type RecorderPolicy,
  readPolicy,
} from "../shared/policy";
import {
  type ConnectionRecord,
  installIdFor,
  installSecret,
  type PendingConnect,
  readLocal,
  readSession,
  removeLocal,
  removeSession,
  writeLocal,
  writeSession,
} from "../shared/storage";
import type { DesktopHandoff, DesktopRefusal } from "./native-host";
import {
  askDesktopForHandoff,
  desktopAddress,
  desktopAvailable,
} from "./native-host";

/** A connection that ended without the person's Disconnect, for the recording controller (index.ts wires it in): OpenBot
 * answered the keep-alive signed out (nothing is forgotten yet), the organization's policy moved the Recorder away from
 * the connection's OpenBot (it is forgotten already), or a connection to another OpenBot, or for another person,
 * replaced it (`endReplaced`: it is replaced already, and its token is revoked once the controller has stopped using
 * it). */
export type ConnectionLoss =
  | {
      kind: "signed-out";
      reason: "revoked" | "removed" | "organization";
      connection: ConnectionRecord;
    }
  | { kind: "policy"; connection: ConnectionRecord }
  | { kind: "replaced"; connection: ConnectionRecord };

type ConnectionDeps = {
  askDesktop: () => Promise<DesktopHandoff | DesktopRefusal | null>;
  desktopAvailable: () => Promise<boolean>;
  /** OpenBot Desktop's own OpenBot address, as its native host confirms it (native-host.ts `desktopAddress`). */
  desktopAddress: () => Promise<string | null>;
  readPolicy: () => Promise<RecorderPolicy>;
  openTab: (url: string) => Promise<number | undefined>; // the new tab's id, kept in pendingConnect.tabId
  /** Stops what the lost connection still has running: the live recording and whatever the document sends with its
   * token. Without the recording controller (a test of this module alone), a sign-out only forgets the connection. */
  connectionLost: (loss: ConnectionLoss) => Promise<void>;
  /** What an approved Connect does next, for the connection OpenBot Desktop made at install (index.ts wires in the
   * recording controller's): a recording of this person goes on under the new token, and their kept recordings are
   * sent. The popup's own Desktop connect reaches it through the router, as an approved Connect does. */
  connected: () => Promise<void>;
};

const PENDING_MAX_AGE_MS = 5 * 60 * 1000;
const OUT_OF_DATE =
  "This page is out of date. Close it and choose Connect this browser in OpenBot again.";
const POLICY_REFUSED =
  "Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.";
/**
 * What the Connect page says when OpenBot did not take the code, by what OpenBot answered. Always the Recorder's own
 * sentence and never the text in OpenBot's answer: the site that asked to connect is any site at all until the person
 * approves it, and the Connect page is the Recorder's own, so a sentence from that site's server would speak in the
 * Recorder's voice (telling the person to install something, say).
 */
const EXCHANGE_REFUSED: Record<number, string> = {
  400: "This connect request has expired or was already used. Choose Connect this browser in OpenBot again.",
  403: "This OpenBot does not accept this copy of the Recorder. Ask whoever runs it to add it.",
  429: "OpenBot is taking too many connect requests just now. Try again in a few minutes.",
};
const EXCHANGE_FAILED = "OpenBot could not connect this browser. Try again.";
const UNREACHABLE = "OpenBot did not answer. Try again.";
/** Nothing about this copy: any site can ask to connect, and until the person approves it on the Connect page that site
 * is any site. Its version and its install id for that origin go to it once it is connected (`ping`). */
const AWAITING_CONFIRMATION: ExternalResponse = {
  ok: true,
  awaitingConfirmation: true,
};
/** Web connects one OpenBot origin may ask for in any ten minutes: enough that an ordinary run (connect, connect again,
 * again after a Disconnect or a revoke, a retry or two) never meets it, while a page asking over and over is held off. */
const CONNECT_WINDOW_MS = 10 * 60 * 1000;
const CONNECT_LIMIT = 10;
const KEEP_ALIVE_ALARM = "recorder-session-keepalive";
const KEEP_ALIVE_PERIOD_MINUTES = 720;
const KEEP_ALIVE_PERIOD_MS = KEEP_ALIVE_PERIOD_MINUTES * 60 * 1000;
/** How long OpenBot Desktop's code waits on its exchange. It runs in the connect queue (see `serially`), so a local OpenBot
 * that never answers must not hold every connect behind it. A trusted OpenBot's page waits as long for its own. */
const DESKTOP_EXCHANGE_WAIT_MS = 10_000;

const defaultDeps: ConnectionDeps = {
  askDesktop: askDesktopForHandoff,
  desktopAvailable,
  desktopAddress,
  readPolicy,
  openTab: async (url) => (await chrome.tabs.create({ url })).id,
  connectionLost: async (loss) => {
    if (loss.kind === "signed-out")
      await forgetConnection(loss.reason, loss.connection.token);
  },
  connected: async () => {},
};

const withDefaults = (deps?: Partial<ConnectionDeps>): ConnectionDeps => ({
  ...defaultDeps,
  ...deps,
});

const connectUrl = () => chrome.runtime.getURL("connect.html");

/** A web connect, Desktop's connect and a decision's clear (`clearPendingConnect`) each read, then write, the pending
 * connect (and a web connect the request count) across storage awaits, so they run one at a time: run side by side,
 * ten connects in one tick would each find the slot empty and open a tab, and the limit would count one of them. A
 * forget told which token asked (`forgetConnection` with `askedWith`), approve's store of the connection and the
 * launcher's queue here too. A job that throws rejects its own caller and the next job still runs. */
let queue: Promise<unknown> = Promise.resolve();
/** Launcher connections waiting in the queue: an install's own Desktop connect, ahead of one there, stores nothing. */
let launcherConnecting = 0;
function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

export function installConnection(deps?: Partial<ConnectionDeps>): void {
  const resolved = withDefaults(deps);
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason !== "install") return;
    await installSecret();
    // A Recorder OpenBot Desktop put in this browser connects as it installs, with nothing to click.
    const answer = await connectThroughDesktop(resolved, { install: true });
    if (answer.connected)
      await resolved
        .connected()
        .catch((error) =>
          console.error("Recorder: reconnect follow-up failed", error),
        );
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM) void keepAlive(resolved);
  });
  void reconcilePolicy(resolved);
  onPolicyChanged(() => void reconcilePolicy(resolved), resolved.readPolicy);
  void scheduleKeepAlive(resolved);
}

/** Alarms can be cleared by a browser restart or an update, so every start makes sure it exists. */
async function scheduleKeepAlive(deps: ConnectionDeps): Promise<void> {
  if (!(await chrome.alarms.get(KEEP_ALIVE_ALARM)))
    await chrome.alarms.create(KEEP_ALIVE_ALARM, {
      periodInMinutes: KEEP_ALIVE_PERIOD_MINUTES,
    });
  const last = await readLocal("lastKeepAliveAt");
  if (last === undefined || Date.now() - last > KEEP_ALIVE_PERIOD_MS)
    await keepAlive(deps);
}

/** Keeps the organization session in use (Decision 2). Only a signed-out answer changes anything: OpenBot being
 * unreachable, or an organization's sign-in server that cannot answer, waits for the next alarm. A signed-out answer
 * goes to the recording controller, which forgets the connection and stops what it still has running. */
async function keepAlive(deps: ConnectionDeps): Promise<void> {
  const connection = await currentConnection();
  if (!connection) return;
  try {
    await openbotJson<RecorderMe>(connection, recorderPaths.me);
  } catch (error) {
    if (error instanceof OpenBotError && error.signedOut)
      await deps.connectionLost({
        kind: "signed-out",
        reason: error.body?.reason ?? "revoked",
        connection,
      });
    return;
  }
  await writeLocal("lastKeepAliveAt", Date.now());
}

export async function currentConnection(): Promise<ConnectionRecord | null> {
  return (await readLocal("connection")) ?? null;
}

type ForgetReason = "revoked" | "removed" | "organization" | "disconnected";

/** Forgets the stored connection, with a signed-out notice giving the reason unless the person disconnected.
 *
 * A caller handling a failed request (a signed-out answer, or a Disconnect's DELETE) must pass the token that request
 * used as `askedWith`. Reconnecting this copy revokes its old token, so a request sent with the old token can finish
 * after approve stored the new connection: with `askedWith`, only the connection that asked is forgotten, notice and
 * all. The check and the forget are one queued job, and approve stores through the queue, so no new connection lands
 * between them. Without `askedWith`, whatever connection is stored is forgotten at once.
 *
 * Resolves true when it forgot a connection: false when `askedWith` is no longer the stored token, or when nothing was
 * stored, so a caller can leave alone what belongs to a connection that stays. */
export async function forgetConnection(
  reason: ForgetReason,
  askedWith?: string,
): Promise<boolean> {
  if (askedWith === undefined) {
    const stored = await currentConnection();
    await forget(reason);
    return stored !== null;
  }
  return serially(async () => {
    if ((await currentConnection())?.token !== askedWith) return false;
    await forget(reason);
    return true;
  });
}

async function forget(reason: ForgetReason): Promise<void> {
  await removeLocal("connection");
  if (reason !== "disconnected")
    await writeLocal("notice", { kind: "signed-out", at: Date.now(), reason });
}

/** page.connect.*, page.disconnect, page.desktop.available, page.connect.desktop; undefined for anything else. */
export async function handleConnectionMessage(
  message: PageToBackground,
  deps?: Partial<ConnectionDeps>,
): Promise<PageResponse | undefined> {
  const resolved = withDefaults(deps);
  switch (message.type) {
    case "page.connect.pending": {
      const pending = await readSession("pendingConnect");
      // Approving replaces whatever this browser is connected to now, so the Connect page names it.
      const connection = pending ? await currentConnection() : null;
      return {
        ok: true,
        pending: pending ? { origin: pending.origin, via: pending.via } : null,
        ...(connection
          ? {
              replaces: {
                origin: connection.openbotUrl,
                email: connection.user.email,
              },
            }
          : {}),
      };
    }
    case "page.connect.decide": {
      const pending = await readSession("pendingConnect");
      // A connect page reads the pending origin once, on load: a tab Chrome did not close when another origin
      // replaced its pending connect (closeConnectTab) still shows the old one, and neither connects nor cancels the
      // site it does not show.
      if (pending && message.origin !== pending.origin)
        return { ok: false, error: OUT_OF_DATE };
      if (message.approve) return approve(pending, message.label, resolved);
      if (pending) await clearPendingConnect(pending, { cancelled: true });
      return { ok: true };
    }
    case "page.disconnect": {
      const connection = await currentConnection();
      if (connection) {
        // Best effort: the token is forgotten here either way, and the person can revoke it in OpenBot.
        await revoke(connection);
        // A reconnect approved while OpenBot was being told is a newer connection, and stays.
        await forgetConnection("disconnected", connection.token);
      }
      return { ok: true };
    }
    case "page.desktop.available":
      return { ok: true, available: await resolved.desktopAvailable() };
    case "page.connect.desktop":
      return { ok: true, ...(await connectThroughDesktop(resolved)) };
    default:
      return undefined;
  }
}

async function approve(
  pending: PendingConnect | undefined,
  label: string,
  deps: ConnectionDeps,
): Promise<PageResponse> {
  if (!pending) return { ok: false, error: "There is nothing to connect." };
  // The policy may have changed since this connect page opened: a pin elsewhere, or a policy gone invalid, refuses it.
  if (!allowsOpenBot(await deps.readPolicy(), pending.origin)) {
    await clearPendingConnect(pending);
    return { ok: false, error: POLICY_REFUSED };
  }
  let exchanged: ExchangeResponse;
  try {
    exchanged = await openbotJson<ExchangeResponse>(
      { openbotUrl: pending.origin },
      recorderPaths.connections,
      {
        body: {
          code: pending.code,
          label,
          installId: await installIdFor(pending.origin),
        },
      },
    );
  } catch (error) {
    // The Recorder's own sentence for what OpenBot answered (EXCHANGE_REFUSED), or a plain one: a network failure's
    // message ("Failed to fetch") means nothing here.
    return {
      ok: false,
      error:
        error instanceof OpenBotError
          ? (EXCHANGE_REFUSED[error.status] ?? EXCHANGE_FAILED)
          : UNREACHABLE,
    };
  }
  const connection: ConnectionRecord = {
    openbotUrl: pending.origin,
    token: exchanged.token,
    connectionId: exchanged.connection.id,
    user: exchanged.user,
    via: pending.via,
    connectedAt: Date.now(),
  };
  // Checked again in the job that stores it: a pin that landed during the exchange keeps it out, and the token OpenBot
  // just made is revoked there. The connection it replaces is read in the same job.
  const stored = await serially(async () => {
    if (!allowsOpenBot(await deps.readPolicy(), pending.origin)) return null;
    const replaced = await currentConnection();
    await writeLocal("connection", connection);
    return { replaced };
  });
  if (!stored) {
    await clearPendingConnect(pending);
    await revoke(connection);
    return { ok: false, error: POLICY_REFUSED };
  }
  await endReplaced(stored.replaced, connection, deps);
  await clearPendingConnect(pending);
  if ((await readLocal("notice"))?.kind === "signed-out")
    await removeLocal("notice");
  return { ok: true };
}

/**
 * What a connection that replaced another does about the one it replaced (`previous`, read in the queued job that stored
 * `next`). The same person on the same OpenBot is this copy connecting again: OpenBot revoked the old token itself at the
 * exchange (one live connection per person and install id), and a recording of theirs goes on under the new token
 * (`connected`, then the recording controller's adoptConnection). Another person, or another OpenBot, lost their
 * connection: the recording controller stops what still runs with its token and keeps everything for them, as a
 * sign-out keeps it (`connectionLost`), then the old token is revoked at its own OpenBot, so no live token is left that
 * this browser no longer holds. In that order, so nothing still sending with the old token meets its revocation first.
 */
async function endReplaced(
  previous: ConnectionRecord | null,
  next: ConnectionRecord,
  deps: ConnectionDeps,
): Promise<void> {
  if (!previous || previous.token === next.token) return;
  if (
    previous.openbotUrl === next.openbotUrl &&
    previous.user.id === next.user.id
  )
    return;
  await deps
    .connectionLost({ kind: "replaced", connection: previous })
    .catch((error) =>
      console.error("Recorder: ending a replaced connection failed", error),
    );
  await revoke(previous);
}

/**
 * The connection the Recorder's launcher hands it (launcher.ts), stored as an approved Connect stores one: checked
 * against the policy in the same queued job that writes it, the signed-out notice gone with it. Nothing pending is
 * asked about, so nothing is shown: the Recorder's own setup tab and a Connect page its install opened on its own are
 * closed, since a browser OpenBot opened needs neither. Resolves false when the policy keeps it out.
 *
 * OpenBot Desktop's native host answers in an OpenBot browser's profile too, so on its first launch the install's own
 * Desktop connect can land just before the launcher's connection. The one it replaces is revoked: this browser needs
 * none, and OpenBot would otherwise go on counting it as a browser of the person's own that OpenBot Desktop connected.
 */
export async function connectFromLauncher(
  connection: ConnectionRecord,
  deps?: Partial<ConnectionDeps>,
): Promise<boolean> {
  const resolved = withDefaults(deps);
  launcherConnecting += 1;
  let stored: { replaced: ConnectionRecord | null } | null;
  try {
    stored = await serially(async () => {
      if (!allowsOpenBot(await resolved.readPolicy(), connection.openbotUrl))
        return null;
      const replaced = await currentConnection();
      await writeLocal("connection", connection);
      return { replaced };
    });
  } finally {
    launcherConnecting -= 1;
  }
  if (!stored) return false;
  const { replaced } = stored;
  if (replaced?.via === "desktop" && replaced.token !== connection.token)
    await revoke(replaced);
  if ((await readLocal("notice"))?.kind === "signed-out")
    await removeLocal("notice");
  const setupTab = await readSession("setupTabId");
  if (setupTab !== undefined) {
    await closeConnectTab(setupTab);
    await removeSession("setupTabId");
  }
  const pending = await readSession("pendingConnect");
  if (pending?.via === "desktop") {
    await closeConnectTab(pending.tabId);
    await clearPendingConnect(pending);
  }
  return true;
}

/** A decision clears only the pending connect it read when it arrived. Approve's exchange runs outside the queue, so
 * a connect never waits on OpenBot's answer, and a decision can wait in the queue behind a connect or Desktop's
 * connect: either way another origin may have replaced the pending connect by now, and that newer one, with its open
 * tab, is left alone. The check and the clear are one queued job, so no connect lands between them. A Cancel is kept
 * for the origin that asked, so its page hears it (`connectStatus`). */
function clearPendingConnect(
  decided: PendingConnect,
  how: { cancelled?: true } = {},
): Promise<void> {
  return serially(async () => {
    const stored = await readSession("pendingConnect");
    if (stored?.origin !== decided.origin || stored.code !== decided.code)
      return;
    await removeSession("pendingConnect");
    if (how.cancelled)
      await writeSession("cancelledConnect", {
        origin: decided.origin,
        at: Date.now(),
      });
  });
}

async function tabIsOpen(tabId: number | undefined): Promise<boolean> {
  if (tabId === undefined) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** A connect page reads the pending origin once, on load. So the tab of a pending connect being replaced is closed
 * first, or it would go on showing a site that is no longer pending (its decide names that site, and is refused).
 * Best effort: a tab the person closed in the meantime leaves nothing to close. */
async function closeConnectTab(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Closed already.
  }
}

/** openbot.ping and openbot.connect from OpenBot's web page. The origin is only ever the one Chrome reports. */
export async function handleExternalConnect(
  message: ExternalToBackground,
  sender: chrome.runtime.MessageSender,
  deps?: Partial<ConnectionDeps>,
): Promise<ExternalResponse> {
  const resolved = withDefaults(deps);
  const origin = sender.origin;
  if (message.type === "openbot.ping") return ping(origin);
  if (message.type === RECORDER_CONNECT_STATUS) return connectStatus(origin);
  if (message.type !== "openbot.connect")
    return { ok: false, error: "invalid" };
  if (!origin) return { ok: false, error: "invalid" };
  const checked = normaliseOpenBotOrigin(origin);
  if (!checked.ok) return { ok: false, error: "not-https" };

  const policy = await resolved.readPolicy();
  if (policy.openbotUrlInvalid) return { ok: false, error: "policy-invalid" };
  if (policy.openbotUrl && !sameOrigin(policy.openbotUrl, checked.origin))
    return { ok: false, error: "pinned-elsewhere" };

  // Counted before anything else is done for it. Asking OpenBot Desktop for its address starts its native host, which
  // looks for OpenBot's own port with lsof or netstat, and any page on a loopback port can ask to connect: counted
  // after, a page asking over and over had the Recorder start that host as often as it liked.
  const throttled = await serially(() =>
    countConnect(checked.origin, Date.now()),
  );
  if (throttled) return throttled;

  // A trusted OpenBot connects with no Connect page, and only while this browser is connected to nothing: replacing a
  // connection (to another OpenBot, or for another person) always asks the person on the Connect page, which names the
  // connection it replaces. Every other site keeps the one Connect click. Only an http origin can be OpenBot Desktop's
  // (its local stack serves plain http on a loopback address), so only then is OpenBot Desktop asked for its address.
  if ((await currentConnection()) === null) {
    const desktop =
      policy.openbotUrl !== checked.origin &&
      new URL(checked.origin).protocol === "http:"
        ? await resolved.desktopAddress()
        : null;
    if (trustedConnectRule(policy, checked.origin, desktop) !== null)
      return trustedConnect(checked.origin, message.code, resolved);
  }
  return serially(() => webConnect(checked.origin, message.code, resolved));
}

/**
 * Which `openbot.connect` the Recorder takes with no Connect page (shared/recorder-page.ts, David 2026-10-22: "only for
 * trusted OpenBots"): one from the OpenBot the organization's policy pins (`policy-pinned`), or from OpenBot Desktop's
 * own address on this computer (`loopback-desktop`). OpenBot Desktop's address is `desktop`, the one its native host
 * confirmed (native-host.ts `desktopAddress`), and only that exact origin is trusted: any program on this computer, a
 * dev server or a notebook among them, can serve a page on a loopback port, so a loopback origin alone proves nothing.
 * https on a loopback IP is never OpenBot Desktop's local stack, which serves plain http. Null for every other origin,
 * for one the policy does not allow, and for every loopback origin when OpenBot Desktop confirmed none.
 */
export function trustedConnectRule(
  policy: RecorderPolicy,
  origin: string,
  desktop: string | null,
): TrustedConnectRule | null {
  const checked = normaliseOpenBotOrigin(origin);
  if (!checked.ok || !allowsOpenBot(policy, checked.origin)) return null;
  if (policy.openbotUrl === checked.origin) return "policy-pinned";
  if (new URL(checked.origin).protocol !== "http:" || desktop === null)
    return null;
  const confirmed = normaliseOpenBotOrigin(desktop);
  return confirmed.ok && confirmed.origin === checked.origin
    ? "loopback-desktop"
    : null;
}

/** Counts a web connect from `origin` against its limit, in the caller's queued job: the refusal when it is over it,
 * else null. */
async function countConnect(
  origin: string,
  now: number,
): Promise<ExternalResponse | null> {
  const requests = await readSession("connectRequests");
  const recent = (requests?.[origin] ?? []).filter(
    (at) => now - at < CONNECT_WINDOW_MS,
  );
  // Not "busy": nothing is pending, and the wait is until the oldest of these leaves the window, which the page says.
  if (recent.length >= CONNECT_LIMIT)
    return {
      ok: false,
      error: "throttled",
      retryAfterMs: Math.min(...recent) + CONNECT_WINDOW_MS - now,
    };
  await writeSession("connectRequests", {
    ...requests,
    [origin]: [...recent, now],
  });
  return null;
}

/**
 * A trusted OpenBot's connect (`trustedConnectRule`), with no Connect page: the person is already in that OpenBot,
 * signed in, asking, and this browser is connected to nothing. Otherwise it is what an approved Connect is, as OpenBot
 * Desktop's connect is: counted against the same limit (by `handleExternalConnect`, first); its code exchanged at the origin Chrome reported, under this
 * copy's install id for it and the browser's own name; the connection stored in a queued job that checks the policy
 * again and that nothing was connected meanwhile (a token either keeps out is revoked: a connection that landed during
 * the exchange is never replaced without the Connect page, and the page asking again gets that page); a Connect page
 * still open closed, since approving it would replace this connection; and the signed-out notice gone. The router then
 * does an approved Connect's follow-up, as the answer says it connected.
 */
async function trustedConnect(
  origin: string,
  code: string,
  deps: ConnectionDeps,
): Promise<ExternalResponse> {
  let exchanged: ExchangeResponse;
  try {
    exchanged = await openbotJson<ExchangeResponse>(
      { openbotUrl: origin },
      recorderPaths.connections,
      {
        body: {
          code,
          label: defaultBrowserName(),
          installId: await installIdFor(origin),
        },
        signal: AbortSignal.timeout(DESKTOP_EXCHANGE_WAIT_MS),
      },
    );
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof OpenBotError
          ? "exchange-refused"
          : "openbot-unreachable",
    };
  }
  const connection: ConnectionRecord = {
    openbotUrl: origin,
    token: exchanged.token,
    connectionId: exchanged.connection.id,
    user: exchanged.user,
    via: "web",
    connectedAt: Date.now(),
  };
  const kept = await serially(async (): Promise<ExternalResponse | null> => {
    if (!allowsOpenBot(await deps.readPolicy(), origin))
      return { ok: false, error: "pinned-elsewhere" };
    if ((await currentConnection()) !== null)
      return { ok: false, error: "busy" };
    await writeLocal("connection", connection);
    const pending = await readSession("pendingConnect");
    if (pending) {
      await closeConnectTab(pending.tabId);
      await removeSession("pendingConnect");
    }
    return null;
  });
  if (kept) {
    await revoke(connection);
    return kept;
  }
  if ((await readLocal("notice"))?.kind === "signed-out")
    await removeLocal("notice");
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    installId: await installIdFor(origin),
    connected: true,
  };
}

/** Everything from the pending connect through the connect tab, in one queued job (see `serially`); the request was
 * counted already, as every connect is first (`handleExternalConnect`). */
async function webConnect(
  origin: string,
  code: string,
  deps: ConnectionDeps,
): Promise<ExternalResponse> {
  const now = Date.now();

  const pending = await readSession("pendingConnect");
  if (pending && (await tabIsOpen(pending.tabId))) {
    // Whatever the pending connect's age, so no page can open more than one connect tab however often it asks.
    if (pending.origin === origin) {
      await writeSession("pendingConnect", {
        ...pending,
        code,
        requestedAt: now,
      });
      await chrome.tabs.update(pending.tabId as number, { active: true });
      return AWAITING_CONFIRMATION;
    }
    if (now - pending.requestedAt < PENDING_MAX_AGE_MS)
      return { ok: false, error: "busy" };
    await closeConnectTab(pending.tabId);
  }
  const next: PendingConnect = {
    origin,
    code,
    via: "web",
    requestedAt: now,
  };
  await writeSession("pendingConnect", next);
  // A new request from the origin that cancelled before is waiting again.
  if ((await readSession("cancelledConnect"))?.origin === origin)
    await removeSession("cancelledConnect");
  const tabId = await deps.openTab(connectUrl());
  if (tabId !== undefined)
    await writeSession("pendingConnect", { ...next, tabId });
  return AWAITING_CONFIRMATION;
}

/**
 * Version and install id only to the connected origin (Decision 22): every other site hears the same bare answer, a
 * site with a connect waiting for the person's click included. The install id is stable for this copy and that origin,
 * so handing it to a site that only asked would let that site know this browser again after its cookies are cleared.
 *
 * Even the bare answer says the Recorder is here, and so does Chrome itself, to every page `externally_connectable`
 * lets in: a page that sends a message to an id with no extension behind it, or to one that does not let that page in,
 * hears "Could not establish connection. Receiving end does not exist." (Chromium's message_service.cc does that on
 * purpose, so a page it refuses cannot tell), while a page an installed extension lets in hears an answer, or "The
 * message port closed before a response was received." when it gives none (both seen in Chrome 151). The Recorder lets
 * in every page, since any OpenBot, at any address, may ask to connect: silence would hide nothing, and OpenBot's own
 * page, which a Recorder not yet connected to it must answer, would be left reading Chrome's error text.
 */
async function ping(origin: string | undefined): Promise<ExternalResponse> {
  if (!origin) return { ok: true };
  const connection = await currentConnection();
  if (connection?.openbotUrl !== origin) return { ok: true };
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    installId: await installIdFor(origin),
  };
}

/**
 * Where the asking origin's own web connect has got to (shared/recorder-page.ts `RecorderConnectWait`), for the page that
 * waits on it: its Connect page open, cancelled there, or closed without a choice. Read from what the Recorder already
 * keeps, asked of Chrome only for whether that tab is still open; it says nothing of any other origin's request, nor of
 * this copy, so it tells a site no more than it caused itself.
 */
async function connectStatus(
  origin: string | undefined,
): Promise<ExternalResponse> {
  const checked = origin ? normaliseOpenBotOrigin(origin) : null;
  if (!checked?.ok) return { ok: true, connect: "none" };
  const pending = await readSession("pendingConnect");
  if (pending?.via === "web" && pending.origin === checked.origin)
    return {
      ok: true,
      connect: (await tabIsOpen(pending.tabId)) ? "waiting" : "closed",
    };
  // A Cancel is news only while a page could still be waiting on it: within the five minutes a request lasts, and before
  // that origin connected by any other way (a trusted OpenBot's connect, OpenBot Desktop's). It was kept for the whole
  // browser session, and only a new web connect from the same origin took it away.
  const cancelled = await readSession("cancelledConnect");
  if (cancelled?.origin !== checked.origin)
    return { ok: true, connect: "none" };
  const stale =
    Date.now() - cancelled.at >= PENDING_MAX_AGE_MS ||
    (await currentConnection())?.openbotUrl === checked.origin;
  if (stale) {
    await serially(async () => {
      if ((await readSession("cancelledConnect"))?.at === cancelled.at)
        await removeSession("cancelledConnect");
    });
    return { ok: true, connect: "none" };
  }
  return { ok: true, connect: "cancelled" };
}

function sameOrigin(raw: string, origin: string): boolean {
  const checked = normaliseOpenBotOrigin(raw);
  return checked.ok && checked.origin === origin;
}

/** Best effort: OpenBot revokes the token (the person can also revoke it in OpenBot). */
async function revoke(connection: ConnectionRecord): Promise<void> {
  try {
    await openbotJson(connection, recorderPaths.currentConnection, {
      method: "DELETE",
    });
  } catch {
    // Unreachable, or already revoked.
  }
}

/** Compares the stored connection with the policy: a policy that pins another origin, or is invalid, forgets the
 * connection and leaves a `policy-moved` notice (its origin empty for an invalid policy), then stops what the connection
 * still has running (the live recording, and whatever the document sends with its token; everything recorded is kept
 * for its person) and revokes the token. Called at every start and on every managed-storage change. The token check
 * keeps a reconnect that lands meanwhile. */
async function reconcilePolicy(deps: ConnectionDeps): Promise<void> {
  const policy = await deps.readPolicy();
  const connection = await currentConnection();
  if (!connection || allowsOpenBot(policy, connection.openbotUrl)) return;
  const moved = policy.openbotUrlInvalid ? "" : (policy.openbotUrl ?? "");
  if (!(await forgetConnection("disconnected", connection.token))) return;
  await writeLocal("notice", {
    kind: "policy-moved",
    at: Date.now(),
    origin: moved,
  });
  await deps.connectionLost({ kind: "policy", connection });
  await revoke(connection);
}

/** Whether OpenBot Desktop connected this browser, or why not, as a code the popup turns into a sentence: OpenBot
 * Desktop's own error code (see DesktopRefusal); `policy-invalid`, `pinned-elsewhere` or `invalid-address` from the
 * checks here; `exchange-refused` or `openbot-unreachable` when OpenBot did not take Desktop's code; or `launched` when
 * the Recorder's launcher connects this browser instead (an install's own connect only). */
export type DesktopConnect =
  | { connected: true }
  | { connected: false; reason: string };

/**
 * Connects this browser through OpenBot Desktop's native host, with no Connect page: the code comes from OpenBot Desktop
 * on this computer, which only the Recorder can ask (the host answers only the Recorder's own extension origin), so
 * there is no web page's request to confirm. The checks are a web connect's (OpenBot's address rule and the
 * organization's policy), and the rest is what an approved Connect does: the code is exchanged at that OpenBot under
 * this copy's install id, the connection is stored in a queued job that checks the policy again (a token it keeps out
 * is revoked), and the signed-out notice goes. The caller then does an approved Connect's follow-up (`connected`).
 *
 * A managed browser connects only where its policy points, on the Desktop path too. Desktop's local stack is always a
 * loopback http address, so a policy naming any other kind of address can never match and Desktop is not asked.
 */
export function connectThroughDesktop(
  deps?: Partial<ConnectionDeps>,
  options: { install?: boolean } = {},
): Promise<DesktopConnect> {
  const resolved = withDefaults(deps);
  return serially(() => desktopConnect(resolved, options.install === true));
}

async function desktopConnect(
  deps: ConnectionDeps,
  install: boolean,
): Promise<DesktopConnect> {
  const refused = (reason: string): DesktopConnect => ({
    connected: false,
    reason,
  });
  // An OpenBot browser's launcher connected it, or is connecting it (`connectFromLauncher`): the connect an install
  // makes on its own would put a second connection in a browser that needs none. Asked before Desktop is asked, and
  // again before the connection is stored, since on a first launch the launcher's connection arrives while Desktop
  // answers. The person's own choice from the popup is left alone.
  const launched = async () =>
    install &&
    (launcherConnecting > 0 ||
      (await currentConnection())?.via === "openbot-browser");
  if (await launched()) return refused("launched");
  const policy = await deps.readPolicy();
  if (policy.openbotUrlInvalid) return refused("policy-invalid");
  if (policy.openbotUrl && !policy.openbotUrl.startsWith("http:"))
    return refused("pinned-elsewhere");
  const handoff = await deps.askDesktop();
  if (!handoff) return refused("no-answer");
  if ("error" in handoff) return refused(handoff.error);
  const checked = normaliseOpenBotOrigin(handoff.openbotUrl);
  if (!checked.ok) return refused("invalid-address");
  if (!allowsOpenBot(policy, checked.origin))
    return refused("pinned-elsewhere");
  if (await launched()) return refused("launched");
  let exchanged: ExchangeResponse;
  try {
    exchanged = await openbotJson<ExchangeResponse>(
      { openbotUrl: checked.origin },
      recorderPaths.connections,
      {
        body: {
          code: handoff.code,
          label: defaultBrowserName(),
          installId: await installIdFor(checked.origin),
        },
        signal: AbortSignal.timeout(DESKTOP_EXCHANGE_WAIT_MS),
      },
    );
  } catch (error) {
    return refused(
      error instanceof OpenBotError
        ? "exchange-refused"
        : "openbot-unreachable",
    );
  }
  const connection: ConnectionRecord = {
    openbotUrl: checked.origin,
    token: exchanged.token,
    connectionId: exchanged.connection.id,
    user: exchanged.user,
    via: "desktop",
    connectedAt: Date.now(),
  };
  // This job is the queued one that stores it: the launcher's connection, or a pin elsewhere, that came while OpenBot
  // answered keeps it out, and the token OpenBot just made is revoked.
  const keptOut = (await launched())
    ? "launched"
    : !allowsOpenBot(await deps.readPolicy(), checked.origin)
      ? "pinned-elsewhere"
      : null;
  if (keptOut) {
    await revoke(connection);
    return refused(keptOut);
  }
  const replaced = await currentConnection();
  await writeLocal("connection", connection);
  await endReplaced(replaced, connection, deps);
  // A Connect page still open would replace this connection if the person approved it: it closes, and nothing is pending.
  const pending = await readSession("pendingConnect");
  if (pending) {
    await closeConnectTab(pending.tabId);
    await removeSession("pendingConnect");
  }
  if ((await readLocal("notice"))?.kind === "signed-out")
    await removeLocal("notice");
  return { connected: true };
}
