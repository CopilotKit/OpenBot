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
      await forgetConnection(error.body?.reason ?? "revoked");
    return;
  }
  await writeLocal("lastKeepAliveAt", Date.now());
}

export async function currentConnection(): Promise<ConnectionRecord | null> {
  return (await readLocal("connection")) ?? null;
}

export async function forgetConnection(
  reason: "revoked" | "removed" | "organization" | "disconnected",
): Promise<void> {
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
    case "page.connect.decide":
      if (message.approve) return approve(message.label);
      await removeSession("pendingConnect");
      return { ok: true };
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
      }
      await forgetConnection("disconnected");
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
    return {
      ok: false,
      error: error instanceof Error ? error.message : "OpenBot did not answer.",
    };
  }
  await writeLocal("connection", {
    openbotUrl: pending.origin,
    token: exchanged.token,
    connectionId: exchanged.connection.id,
    user: exchanged.user,
    via: pending.via,
    connectedAt: Date.now(),
  });
  await removeSession("pendingConnect");
  if ((await readLocal("notice"))?.kind === "signed-out")
    await removeLocal("notice");
  return { ok: true };
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

  const now = Date.now();
  const requests = await readSession("connectRequests");
  const recent = (requests?.[checked.origin] ?? []).filter(
    (at) => now - at < CONNECT_WINDOW_MS,
  );
  if (recent.length >= CONNECT_LIMIT) return { ok: false, error: "busy" };
  await writeSession("connectRequests", {
    ...requests,
    [checked.origin]: [...recent, now],
  });

  const pending = await readSession("pendingConnect");
  if (pending && now - pending.requestedAt < PENDING_MAX_AGE_MS) {
    const open = await tabIsOpen(pending.tabId);
    if (open && pending.origin !== checked.origin)
      return { ok: false, error: "busy" };
    if (open) {
      await writeSession("pendingConnect", {
        ...pending,
        code: message.code,
        requestedAt: now,
      });
      await chrome.tabs.update(pending.tabId as number, { active: true });
      return connected(checked.origin);
    }
  }
  const next: PendingConnect = {
    origin: checked.origin,
    code: message.code,
    via: "web",
    requestedAt: now,
  };
  await writeSession("pendingConnect", next);
  const tabId = await resolved.openTab(connectUrl());
  if (tabId !== undefined)
    await writeSession("pendingConnect", { ...next, tabId });
  return connected(checked.origin);
}

async function connected(origin: string): Promise<ExternalResponse> {
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
export async function offerDesktopConnection(
  deps?: Partial<ConnectionDeps>,
): Promise<boolean> {
  const resolved = withDefaults(deps);
  const policy = await resolved.readPolicy();
  if (policy.openbotUrlInvalid) return false;
  if (policy.openbotUrl && !policy.openbotUrl.startsWith("http:")) return false;
  const handoff = await resolved.askDesktop();
  if (!handoff) return false;
  const checked = normaliseOpenBotOrigin(handoff.openbotUrl);
  if (!checked.ok) return false;
  if (policy.openbotUrl && !sameOrigin(policy.openbotUrl, checked.origin))
    return false;
  const pending: PendingConnect = {
    origin: checked.origin,
    code: handoff.code,
    via: "desktop",
    requestedAt: Date.now(),
  };
  await writeSession("pendingConnect", pending);
  const tabId = await resolved.openTab(connectUrl());
  if (tabId !== undefined)
    await writeSession("pendingConnect", { ...pending, tabId });
  return true;
}
