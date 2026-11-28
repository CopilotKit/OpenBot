/**
 * What the page may tell the app, and the checks every message passes before the app listens.
 *
 * react-native-webview's message channel is open to every frame: on iOS the script message handler
 * answers any frame, and on Android the web message listener is registered for the origin "*". So a
 * message counts only when it carries this launch's random token, which only the script the app put
 * into the MAIN frame of its OWN origin knows (it lives in that script's closure), and when the URL
 * the web view reports for it (iOS: the sending frame's; Android: the sending origin) is the app's
 * own origin. Pure: unit-tested in __tests__/bridge.test.ts.
 */
import type { PageMessage, Tab } from "./machine";
import { isOwnOrigin } from "./urls";

const TABS = new Set(["conversations", "home", "bots"]);

export function parsePageMessage(
  data: string,
  senderUrl: string | null | undefined,
  origin: string,
  token: string,
): PageMessage | null {
  if (!isOwnOrigin(senderUrl, origin)) return null;
  if (typeof data !== "string" || data.length > 10_000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof token !== "string" || token.length < 16 || record.token !== token) return null;
  switch (record.kind) {
    case "doc":
      return { kind: "doc", late: record.late === true };
    case "tap":
      return { kind: "tap" };
    case "text": {
      const body = Number(record.body);
      const main = Number(record.main);
      if (!Number.isFinite(body) || !Number.isFinite(main)) return null;
      return { kind: "text", body: Math.max(0, body), main: Math.max(0, main) };
    }
    case "chrome": {
      const color = typeof record.color === "string" ? record.color : "";
      if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
      return { kind: "chrome", color: color.toLowerCase(), dark: record.dark === true };
    }
    case "alert":
      return { kind: "alert", message: String(record.message ?? "").slice(0, 2_000) };
    case "open":
      return { kind: "open", handled: record.handled === true };
    case "bridge":
      return parseBridge(record.message);
    default:
      return null;
  }
}

/** The web app's own messages (app/src/lib/native-shell/bridge.ts): ready, route, signed-out. */
function parseBridge(message: unknown): PageMessage | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  switch (record.type) {
    case "ready":
      return { kind: "bridge", message: { type: "ready" } };
    case "signed-out":
      return { kind: "bridge", message: { type: "signed-out" } };
    case "route": {
      if (typeof record.path !== "string" || !record.path.startsWith("/")) return null;
      const tab = typeof record.tab === "string" && TABS.has(record.tab) ? (record.tab as Tab) : null;
      return {
        kind: "bridge",
        message: { type: "route", path: record.path.slice(0, 2_000), tab, signedIn: record.signedIn === true },
      };
    }
    default:
      return null;
  }
}
