import {
  type ExchangeResponse,
  type RecorderMe,
  recorderPaths,
} from "@openbot/shared/recorder-api";
import type {
  ExternalResponse,
  ExternalToBackground,
  PageResponse,
  PageToBackground,
} from "../protocol/messages";
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
import { askDesktopForHandoff, desktopAvailable } from "./native-host";

/** A connection that ended without the person's Disconnect, for the recording controller (index.ts wires it in): OpenBot
 * answered the keep-alive signed out (nothing is forgotten yet), or the organization's policy moved the Recorder away
 * from the connection's OpenBot (it is forgotten already). */
export type ConnectionLoss =
  | {
      kind: "signed-out";
      reason: "revoked" | "removed" | "organization";
      connection: ConnectionRecord;
    }
  | { kind: "policy"; connection: ConnectionRecord };

type ConnectionDeps = {
  askDesktop: () => Promise<DesktopHandoff | DesktopRefusal | null>;
  desktopAvailable: () => Promise<boolean>;
  readPolicy: () => Promise<RecorderPolicy>;
  openTab: (url: string) => Promise<number | undefined>; // the new tab's id, kept in pendingConnect.tabId
  /** Stops what the lost connection still has running: the live recording and whatever the document sends with its
   * token. Without the recording controller (a test of this module alone), a sign-out only forgets the connection. */
  connectionLost: (loss: ConnectionLoss) => Promise<void>;
};

const PENDING_MAX_AGE_MS = 5 * 60 * 1000;
const OUT_OF_DATE =
  "This page is out of date. Close it and choose Connect this browser in OpenBot again.";
const POLICY_REFUSED =
  "Your organization's Recorder policy does not allow this OpenBot. Ask your IT team.";
/** Web connects one OpenBot origin may ask for in any ten minutes: enough that an ordinary run (connect, connect again,
 * again after a Disconnect or a revoke, a retry or two) never meets it, while a page asking over and over is held off. */
const CONNECT_WINDOW_MS = 10 * 60 * 1000;
const CONNECT_LIMIT = 10;
const KEEP_ALIVE_ALARM = "recorder-session-keepalive";
const KEEP_ALIVE_PERIOD_MINUTES = 720;
const KEEP_ALIVE_PERIOD_MS = KEEP_ALIVE_PERIOD_MINUTES * 60 * 1000;

const defaultDeps: ConnectionDeps = {
  askDesktop: askDesktopForHandoff,
  desktopAvailable,
  readPolicy,
  openTab: async (url) => (await chrome.tabs.create({ url })).id,
  connectionLost: async (loss) => {
    if (loss.kind === "signed-out")
      await forgetConnection(loss.reason, loss.connection.token);
  },
};

const withDefaults = (deps?: Partial<ConnectionDeps>): ConnectionDeps => ({
  ...defaultDeps,
  ...deps,
});

const connectUrl = () => chrome.runtime.getURL("connect.html");

/** A web connect, Desktop's handoff and a decision's clear (`clearPendingConnect`) each read, then write, the pending
 * connect (and a web connect the request count) across storage awaits, so they run one at a time: run side by side,
 * ten connects in one tick would each find the slot empty and open a tab, and the limit would count one of them. A
 * forget told which token asked (`forgetConnection` with `askedWith`) and approve's store of the connection queue here
 * too. A job that throws rejects its own caller and the next job still runs. */
let queue: Promise<unknown> = Promise.resolve();
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
    await offerDesktopConnection(resolved);
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
      return {
        ok: true,
        pending: pending ? { origin: pending.origin, via: pending.via } : null,
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
      if (pending) await clearPendingConnect(pending);
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
      return { ok: true, ...(await offerDesktopConnection(resolved)) };
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
    // The server's own sentence, or a plain one: a network failure's message ("Failed to fetch") means nothing here.
    return {
      ok: false,
      error:
        error instanceof OpenBotError
          ? error.message
          : "OpenBot did not answer. Try again.",
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
  // just made is revoked there.
  const stored = await serially(async () => {
    if (!allowsOpenBot(await deps.readPolicy(), pending.origin)) return false;
    await writeLocal("connection", connection);
    return true;
  });
  if (!stored) {
    await clearPendingConnect(pending);
    await revoke(connection);
    return { ok: false, error: POLICY_REFUSED };
  }
  await clearPendingConnect(pending);
  if ((await readLocal("notice"))?.kind === "signed-out")
    await removeLocal("notice");
  return { ok: true };
}

/** A decision clears only the pending connect it read when it arrived. Approve's exchange runs outside the queue, so
 * a connect never waits on OpenBot's answer, and a decision can wait in the queue behind a connect or Desktop's
 * handoff: either way another origin may have replaced the pending connect by now, and that newer one, with its open
 * tab, is left alone. The check and the clear are one queued job, so no connect lands between them. */
function clearPendingConnect(decided: PendingConnect): Promise<void> {
  return serially(async () => {
    const stored = await readSession("pendingConnect");
    if (stored?.origin === decided.origin && stored.code === decided.code)
      await removeSession("pendingConnect");
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
  if (message.type !== "openbot.connect")
    return { ok: false, error: "invalid" };
  if (!origin) return { ok: false, error: "invalid" };
  const checked = normaliseOpenBotOrigin(origin);
  if (!checked.ok) return { ok: false, error: "not-https" };

  const policy = await resolved.readPolicy();
  if (policy.openbotUrlInvalid) return { ok: false, error: "policy-invalid" };
  if (policy.openbotUrl && !sameOrigin(policy.openbotUrl, checked.origin))
    return { ok: false, error: "pinned-elsewhere" };

  return serially(() => webConnect(checked.origin, message.code, resolved));
}

/** Everything from the request count through the connect tab, in one queued job (see `serially`). */
async function webConnect(
  origin: string,
  code: string,
  deps: ConnectionDeps,
): Promise<ExternalResponse> {
  const now = Date.now();
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
      return awaitingConfirmationAnswer(origin);
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
  const tabId = await deps.openTab(connectUrl());
  if (tabId !== undefined)
    await writeSession("pendingConnect", { ...next, tabId });
  return awaitingConfirmationAnswer(origin);
}

async function awaitingConfirmationAnswer(
  origin: string,
): Promise<ExternalResponse> {
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    installId: await installIdFor(origin),
    awaitingConfirmation: true,
  };
}

/** Version and install id only to the connected origin or the origin of a connect flow still pending (Decision 22). */
async function ping(origin: string | undefined): Promise<ExternalResponse> {
  if (!origin) return { ok: true };
  const connection = await currentConnection();
  const pending = await readSession("pendingConnect");
  const known =
    connection?.openbotUrl === origin ||
    (pending?.origin === origin &&
      Date.now() - pending.requestedAt < PENDING_MAX_AGE_MS);
  if (!known) return { ok: true };
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    installId: await installIdFor(origin),
  };
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

/** Whether Desktop's connect page opened, or why not, as a code the popup turns into a sentence: OpenBot Desktop's own
 * error code (see DesktopRefusal), or `policy-invalid`, `pinned-elsewhere` or `invalid-address` from the checks here. */
export type DesktopOffer =
  | { offered: true }
  | { offered: false; reason: string };

/** A managed browser connects only where its policy points, on the Desktop path too. Desktop's local stack is always
 * a loopback http address, so a policy naming any other kind of address can never match and Desktop is not asked. */
export function offerDesktopConnection(
  deps?: Partial<ConnectionDeps>,
): Promise<DesktopOffer> {
  const resolved = withDefaults(deps);
  return serially(() => desktopConnect(resolved));
}

async function desktopConnect(deps: ConnectionDeps): Promise<DesktopOffer> {
  const refused = (reason: string): DesktopOffer => ({
    offered: false,
    reason,
  });
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
  await closeConnectTab((await readSession("pendingConnect"))?.tabId);
  const pending: PendingConnect = {
    origin: checked.origin,
    code: handoff.code,
    via: "desktop",
    requestedAt: Date.now(),
  };
  await writeSession("pendingConnect", pending);
  const tabId = await deps.openTab(connectUrl());
  if (tabId !== undefined)
    await writeSession("pendingConnect", { ...pending, tabId });
  return { offered: true };
}
