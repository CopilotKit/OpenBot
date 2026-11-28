/*
 * FOR CI ONLY. An https front for a mock stack, so the iOS shell's tests meet production's rules:
 * App Transport Security with no exception, Secure cookies, wss.
 *
 *   bun ios-shell/ci/tls-proxy.ts <listen port> <upstream http origin> <cert.pem> <key.pem>
 *
 * Forwards every request (and WebSocket upgrades) to the upstream unchanged, adding
 * X-Forwarded-Proto: https and X-Forwarded-Host, and never follows redirects. Listens on 127.0.0.1
 * only. No dependency beyond bun.
 */

const [portText, upstream, certPath, keyPath] = process.argv.slice(2);
if (!portText || !upstream || !certPath || !keyPath) {
  console.error("usage: tls-proxy.ts <port> <upstream origin> <cert.pem> <key.pem>");
  process.exit(2);
}
const upstreamWs = upstream.replace(/^http/, "ws");

type Bridge = { target: string; protocols: string[]; upstream?: WebSocket; queue: (string | Uint8Array)[] };

Bun.serve<Bridge>({
  hostname: "127.0.0.1",
  port: Number(portText),
  tls: { cert: Bun.file(certPath), key: Bun.file(keyPath) },
  async fetch(request, server) {
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const ok = server.upgrade(request, { data: { target: upstreamWs + path, protocols, queue: [] } });
      return ok ? undefined : new Response("expected a websocket upgrade", { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", url.host);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    try {
      return await fetch(upstream + path, { method: request.method, headers, body, redirect: "manual" });
    } catch (error) {
      return new Response(`upstream failed: ${error}`, { status: 502 });
    }
  },
  websocket: {
    open(ws) {
      const bridge = ws.data;
      const up = new WebSocket(bridge.target, bridge.protocols.length ? bridge.protocols : undefined);
      up.binaryType = "arraybuffer";
      bridge.upstream = up;
      up.onopen = () => {
        for (const message of bridge.queue) up.send(message);
        bridge.queue = [];
      };
      up.onmessage = (event) => {
        ws.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
      };
      up.onclose = () => ws.close();
      up.onerror = () => ws.close(1011, "upstream error");
    },
    message(ws, message) {
      const up = ws.data.upstream;
      if (up && up.readyState === WebSocket.OPEN) up.send(message);
      else ws.data.queue.push(message);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});

console.log(`tls proxy on https://127.0.0.1:${portText} -> ${upstream}`);
