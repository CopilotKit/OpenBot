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
import { type RecorderPolicy, readPolicy } from "../shared/policy";
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
import type { DesktopHandoff } from "./native-host";
import { askDesktopForHandoff, desktopAvailable } from "./native-host";

export type ConnectionDeps = {
  askDesktop: () => Promise<DesktopHandoff | null>;
  desktopAvailable: () => Promise<boolean>;
  readPolicy: () => Promise<RecorderPolicy>;
  openTab: (url: string) => Promise<number | undefined>; // the new tab's id, kept in pendingConnect.tabId
};

const PENDING_MAX_AGE_MS = 5 * 60 * 1000;
const CONNECT_WINDOW_MS = 10 * 60 * 1000;
const CONNECT_LIMIT = 3;
const KEEP_ALIVE_ALARM = "recorder-session-keepalive";
const KEEP_ALIVE_PERIOD_MINUTES = 720;
const KEEP_ALIVE_PERIOD_MS = KEEP_ALIVE_PERIOD_MINUTES * 60 * 1000;

const defaultDeps: ConnectionDeps = {
  askDesktop: askDesktopForHandoff,
  desktopAvailable,
  readPolicy,
  openTab: async (url) => (await chrome.tabs.create({ url })).id,
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
    if (alarm.name === KEEP_ALIVE_ALARM) void keepAlive();
  });
  void reconcilePolicy();
  void scheduleKeepAlive();
}

/** Alarms can be cleared by a browser restart or an update, so every start makes sure it exists. */
async function scheduleKeepAlive(): Promise<void> {
  if (!(await chrome.alarms.get(KEEP_ALIVE_ALARM)))
    await chrome.alarms.create(KEEP_ALIVE_ALARM, {
      periodInMinutes: KEEP_ALIVE_PERIOD_MINUTES,
    });
  const last = await readLocal("lastKeepAliveAt");
  if (last === undefined || Date.now() - last > KEEP_ALIVE_PERIOD_MS)
    await keepAlive();
}

/** Keeps the organization session in use (Decision 2). Only a signed-out answer changes anything: OpenBot being
 * unreachable, or an organization's sign-in server that cannot answer, waits for the next alarm. */
async function keepAlive(): Promise<void> {
  const connection = await currentConnection();
  if (!connection) return;
  try {
    await openbotJson<RecorderMe>(connection, recorderPaths.me);
  } catch (error) {
    if (error instanceof OpenBotError && error.signedOut)
      await forgetConnection(error.body?.reason ?? "revoked", connection.token);
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
 * between them. Without `askedWith`, whatever connection is stored is forgotten at once. */
export function forgetConnection(
  reason: ForgetReason,
  askedWith?: string,
): Promise<void> {
  if (askedWith === undefined) return forget(reason);
  return serially(async () => {
    if ((await currentConnection())?.token === askedWith) await forget(reason);
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
      if (message.approve) return approve(message.label);
      const pending = await readSession("pendingConnect");
      if (pending) await clearPendingConnect(pending);
      return { ok: true };
    }
    case "page.disconnect": {
      const connection = await currentConnection();
      if (connection) {
        try {
          await openbotJson(connection, recorderPaths.currentConnection, {
            method: "DELETE",
          });
        } catch {
          // Best effort: the token is forgotten here either way, and the person can revoke it in OpenBot.
        }
        // A reconnect approved while OpenBot was being told is a newer connection, and stays.
        await forgetConnection("disconnected", connection.token);
      }
      return { ok: true };
    }
    case "page.desktop.available":
      return { ok: true, available: await resolved.desktopAvailable() };
    case "page.connect.desktop":
      return { ok: true, offered: await offerDesktopConnection(resolved) };
    default:
      return undefined;
  }
}

async function approve(label: string): Promise<PageResponse> {
  const pending = await readSession("pendingConnect");
  if (!pending) return { ok: false, error: "There is nothing to connect." };
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
  await serially(() =>
    writeLocal("connection", {
      openbotUrl: pending.origin,
      token: exchanged.token,
      connectionId: exchanged.connection.id,
      user: exchanged.user,
      via: pending.via,
      connectedAt: Date.now(),
    }),
  );
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

/** A connect page reads the pending origin once, on load, while its Connect button exchanges whatever is pending at
 * the click. So the tab of a pending connect being replaced is closed first, or it would show one site and connect
 * another. Best effort: a tab the person closed in the meantime leaves nothing to close. */
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
  if (recent.length >= CONNECT_LIMIT) return { ok: false, error: "busy" };
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

/** Compares the stored connection with the policy once (Task 22 makes it real); called by installConnection at every start. */
export async function reconcilePolicy(): Promise<void> {}

/** A managed browser connects only where its policy points, on the Desktop path too. Desktop's local stack is always
 * a loopback http address, so a policy naming any other kind of address can never match and Desktop is not asked. */
export function offerDesktopConnection(
  deps?: Partial<ConnectionDeps>,
): Promise<boolean> {
  const resolved = withDefaults(deps);
  return serially(() => desktopConnect(resolved));
}

async function desktopConnect(deps: ConnectionDeps): Promise<boolean> {
  const policy = await deps.readPolicy();
  if (policy.openbotUrlInvalid) return false;
  if (policy.openbotUrl && !policy.openbotUrl.startsWith("http:")) return false;
  const handoff = await deps.askDesktop();
  if (!handoff) return false;
  const checked = normaliseOpenBotOrigin(handoff.openbotUrl);
  if (!checked.ok) return false;
  if (policy.openbotUrl && !sameOrigin(policy.openbotUrl, checked.origin))
    return false;
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
  return true;
}
