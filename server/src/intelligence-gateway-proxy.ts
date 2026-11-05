/**
 * The Intelligence gateway's client socket, served from OpenBot's own address.
 *
 * The browser opens the gateway itself: the runtime hands it the socket address in `/info` and with
 * every run, and the conversation streams over it. That is fine where the gateway has an address of
 * its own that the browser can reach, as managed Intelligence does. It is not fine where Intelligence
 * runs inside the cluster beside OpenBot and the only way in is OpenBot's address: a `kubectl
 * port-forward` to the server, or one Ingress host. There the browser would be told a Service name it
 * cannot resolve, every conversation would sit waiting for a socket that never opens, and nothing on
 * the screen would say why.
 *
 * With `INTELLIGENCE_GATEWAY_PROXY=on` the browser is told {@link INTELLIGENCE_CLIENT_SOCKET_PATH}
 * instead, on OpenBot, and this carries each socket on to the gateway's `/client` unchanged. The
 * gateway still authorizes every connection with the join token the runtime issued, which travels in
 * the query exactly as it would have; nothing here reads it. What this adds is OpenBot's own front
 * door in front of it (the cross-site and single-user checks every socket gets, and a session).
 *
 * Phoenix, which the browser's client is, appends `/websocket` to the address it is given, and a
 * path-only address is resolved against the page, so `ws://` or `wss://` and the port come from
 * wherever the person reached OpenBot.
 */

/** Where the browser is told the gateway's client socket is, when this proxy is on. */
export const INTELLIGENCE_CLIENT_SOCKET_PATH = "/api/intelligence/client";

/** The one path that socket arrives on: Phoenix's websocket transport under the address above. */
const PROXIED_PATH = `${INTELLIGENCE_CLIENT_SOCKET_PATH}/websocket`;

export function isIntelligenceClientSocketPath(pathname: string): boolean {
  return pathname === PROXIED_PATH;
}

/**
 * The address the browser is given: on the public URL when there is one, so it is a whole URL that
 * anything holding it can open, and otherwise a path that the browser resolves against the page.
 */
export function proxiedClientSocketUrl(publicUrl: string | undefined): string {
  const base = publicUrl?.trim().replace(/\/+$/, "");
  if (!base) return INTELLIGENCE_CLIENT_SOCKET_PATH;
  return `${base.replace(/^http/, "ws")}${INTELLIGENCE_CLIENT_SOCKET_PATH}`;
}

/**
 * The gateway socket a browser's connection is carried to: the gateway's own `/client/websocket`,
 * with the browser's query (its protocol version and join token) as it came.
 *
 * `gatewayWsUrl` is the address this server already reaches the gateway at, written any of the ways
 * the runtime accepts: the bare origin, or ending in `/client`, `/runner` or `/channels`.
 */
export function gatewayClientSocketUrl(
  gatewayWsUrl: string,
  requestUrl: URL,
): string {
  let base = gatewayWsUrl.trim().replace(/\/+$/, "");
  for (const socket of ["/client", "/runner", "/channels"]) {
    if (base.endsWith(socket)) {
      base = base.slice(0, -socket.length);
      break;
    }
  }
  return `${base.replace(/^http/, "ws")}/client/websocket${requestUrl.search}`;
}

/** What a proxied gateway socket carries in Bun's per-socket data. */
export type GatewaySocketData = {
  gatewayUpstream: string;
  inward?: WebSocket;
  /** Frames the browser sent before the gateway's side was open, in order. */
  pending: (string | Uint8Array)[];
};

/** The outward socket, as much of Bun's ServerWebSocket as this uses. */
type Outward = {
  data: GatewaySocketData;
  send(message: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
};

/**
 * A close code that may be sent on a socket. 1005, 1006 and 1015 describe a close that had no frame
 * and are never put in one; anything outside the ranges the protocol assigns is not a code at all.
 */
function sendableCloseCode(code: number | undefined): number | undefined {
  if (code === undefined) return undefined;
  if (code === 1005 || code === 1006 || code === 1015) return undefined;
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  )
    return code;
  return undefined;
}

function closeWith(
  socket: { close(code?: number, reason?: string): void },
  code: number | undefined,
  reason: string | undefined,
) {
  const sendable = sendableCloseCode(code);
  try {
    if (sendable === undefined) socket.close();
    else socket.close(sendable, reason ?? "");
  } catch {
    // Already closing; the close the other side sees is the one already under way.
  }
}

/**
 * Open the gateway's side of a socket the browser has just opened.
 *
 * Every frame is carried as it came, text as text and binary as binary, because the Phoenix
 * serializer uses both. Unlike the live screen, nothing is dropped: the first thing a Phoenix client
 * sends is its channel join, the moment its own socket opens, which is before this one is, and a
 * dropped join is a conversation that waits ten seconds for a retry with nothing on the screen.
 */
export function openGatewaySocket(ws: Outward): void {
  const inward = new WebSocket(ws.data.gatewayUpstream);
  inward.binaryType = "arraybuffer";
  ws.data.inward = inward;
  inward.onopen = () => {
    for (const frame of ws.data.pending.splice(0)) inward.send(frame);
  };
  inward.onmessage = (event) => {
    try {
      ws.send(
        typeof event.data === "string"
          ? event.data
          : new Uint8Array(event.data as ArrayBuffer),
      );
    } catch {
      inward.close();
    }
  };
  inward.onclose = (event) => closeWith(ws, event.code, event.reason);
  inward.onerror = () =>
    closeWith(ws, 1011, "The Intelligence gateway could not be reached.");
}

/** A frame from the browser: on to the gateway, or held until the gateway's side is open. */
export function gatewaySocketMessage(
  ws: Outward,
  message: string | Uint8Array,
): void {
  const inward = ws.data.inward;
  if (inward?.readyState === WebSocket.OPEN) {
    inward.send(message);
    return;
  }
  if (!inward || inward.readyState === WebSocket.CONNECTING) {
    ws.data.pending.push(message);
  }
}

/** The browser went away: so does the gateway's side, with the same code where it is one to send. */
export function closeGatewaySocket(
  ws: Outward,
  code: number | undefined,
  reason: string | undefined,
): void {
  ws.data.pending.length = 0;
  const inward = ws.data.inward;
  if (!inward) return;
  if (
    inward.readyState === WebSocket.CLOSING ||
    inward.readyState === WebSocket.CLOSED
  )
    return;
  closeWith(inward, code, reason);
}
