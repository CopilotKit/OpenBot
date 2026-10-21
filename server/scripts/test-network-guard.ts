/**
 * The test process's egress, closed at the transport rather than asked for politely file by file.
 *
 * A test that dials a vendor stops being a fact about this repository. It passes or fails on the
 * vendor's uptime, on DNS and on whatever the network did that minute, so a red says nothing and a
 * green says less than it looks like; it is slow and flaky in a suite this size; it carries
 * whatever the test handed it — an API key, a user id, a return address — to a third party; and it
 * is a real request against a real service, made from CI, on every run.
 *
 * EVERY TEST FILE ALREADY MEANT TO STUB, AND STUBBING PER FILE IS WHAT FAILED. `server/tests/
 * composio-broker-seam.test.ts` assigned `globalThis.fetch` around the call it was about and still
 * reached `https://backend.composio.dev/api/v3.1/auth_configs` on every run, because the vendor
 * client had been constructed one line EARLIER and `@composio/client` binds its transport once, at
 * construction (`this.fetch = options.fetch ?? Shims.getDefaultFetch()`, `client.mjs:122`). A stub
 * installed after that point is a stub the SDK never sees. That failure mode is invisible in review
 * — the file reads as if it stubs — which is why the floor is here, in a preload that runs before
 * any test file is imported and therefore before any vendor client can capture a transport.
 *
 * WHAT IS REFUSED: a connection to anything that is not loopback, through every way this runtime
 * (Bun 1.4) offers a test file of opening one. Patching `globalThis.fetch` and `http.request` alone
 * is not that: an earlier version of this file did only that, and `https.get`, `Bun.fetch`, the
 * named imports `import { get } from "node:https"`, the built-in `undici`, `net`, `tls`,
 * `Bun.connect`, `WebSocket` and `dgram` all still reached example.com. Each one is closed below,
 * at the lowest layer JavaScript can reach for it:
 *
 *  - `Bun.fetch` is a read-only, non-configurable property and cannot be replaced, and the built-in
 *    `undici` captured the native fetch before this file ran. Both honour the proxy environment, so
 *    the process's HTTP(S) proxy is pointed at a refusing listener on loopback (`NO_PROXY` keeps the
 *    suite's own loopback servers direct). Every native fetch to a far host is handed to that
 *    listener, which records it and answers 403 without ever opening a socket onward.
 *  - `globalThis.fetch` is still replaced too, so the common path rejects with the explanation
 *    below instead of resolving a 403.
 *  - `node:http`/`node:https` do NOT read the proxy environment, so `request`, `get` and
 *    `ClientRequest` are replaced on both, and `syncBuiltinESMExports()` pushes the replacements into
 *    the named-import bindings, which Bun otherwise snapshots when the built-in first loads.
 *  - `node:net`/`node:tls` are guarded on `net.Socket.prototype.connect`, which `net.connect`,
 *    `net.createConnection` and `tls.connect` all reach; `Bun.connect`, `node:http2`'s `connect`,
 *    `WebSocket` (global, `ws`, `undici`, `node:http`) and UDP (`dgram`, `Bun.udpSocket`) likewise.
 *
 * Raw sockets are allowed to one more place than loopback: the hosts of `TEST_DATABASE_URL` and
 * `DATABASE_URL`, because that is how the Postgres driver reaches the test database and that host is
 * deployment configuration, not necessarily loopback.
 *
 * AND RAW SOCKETS ARE JUDGED BY THE ADDRESS THEY REACH, because some suites' SUBJECT is the socket
 * layer. `agent-computer`'s egress filter has to prove it pins the address it checked, falls back
 * to the next one, and gives up on one that never answers, and it can only prove that by opening
 * sockets at `rebind.example.test`, `dual.example.test` and `10.255.255.1`. None of those can be a
 * vendor, and the rule that admits them says why — not a list of the hosts a suite happens to use:
 *  - a LITERAL address the public internet does not route (RFC 1918 private, the RFC 5737/3849
 *    documentation ranges, IPv6 unique-local). Link-local is excluded on purpose: 169.254.169.254 is
 *    the cloud metadata service, which hands out credentials.
 *  - a name under a top-level domain RFC 6761 reserves so public DNS never answers it (`.test`,
 *    `.invalid`, `.example`) — and ONLY with its lookup wrapped, because a `lookup` option or
 *    `/etc/hosts` can map a reserved name to any address. The wrapped lookup lets the connection
 *    proceed only if every address it answers is one a literal would be let through to, so a name
 *    is never the way round the address rule.
 * This is at `net.Socket#connect` only, where a lookup can be checked. Every other entry point
 * (`fetch`, `http(s).request`/`get`, `http2`, `WebSocket`) stays loopback-only, and
 * `Bun.connect`/UDP take the same literal-address rule but no names.
 * Why not a named opt-out like `OPENBOT_LIVE_*`: `bun run test:ci` runs every file in ONE process,
 * so a flag one suite set would unguard every file after it.
 *
 * WHAT IS NOT GUARDED, AND WHY — none of these is how any code in this repository talks to a vendor:
 * `Bun.SQL` (native; it IS the database path, and its connection never surfaces to JavaScript);
 * `Bun.S3Client`/`Bun.redis` (native clients this repository does not use); a `fetch` given an
 * explicit `proxy` or `unix` option, or a test that rewrites the proxy variables itself; a child
 * process (`Bun.spawn`, `child_process` running `curl`); a `Worker`, whose global scope does not
 * run this preload; and DNS lookups, which resolve a name but connect to nothing.
 * `server/tests/test-network-guard.test.ts` plants a call through every guarded entry point.
 *
 * HOW A SUITE THAT IS MEANT TO DIAL OPTS OUT: any `OPENBOT_LIVE_*` variable with a non-empty value.
 * The three live suites already set one — `OPENBOT_LIVE_COMPOSIO`, `OPENBOT_LIVE_ARCADE` and
 * `OPENBOT_LIVE_SCREEN` are set by their `test:live-*` scripts in `package.json`, which also refuse
 * to run without a key, so a live suite remains deliberate and credentialed and stays skipped
 * otherwise.
 */

import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const liveRun = Object.entries(process.env).some(
  ([name, value]) => name.startsWith("OPENBOT_LIVE_") && (value ?? "").trim(),
);

/** Loopback, in every spelling a URL or a Node request option can arrive in. */
function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0.0.0.0" ||
    bare === "::" ||
    bare === "" ||
    bare.endsWith(".localhost") ||
    /^127\./.test(bare) ||
    /^::ffff:127\./.test(bare)
  );
}

/** The configured database hosts, read when asked, since a test may point either variable elsewhere. */
function isDatabaseHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return [process.env.TEST_DATABASE_URL, process.env.DATABASE_URL].some(
    (configured) => {
      if (!configured) return false;
      try {
        return (
          new URL(configured).hostname.replace(/^\[|\]$/g, "").toLowerCase() ===
          bare
        );
      } catch {
        return false;
      }
    },
  );
}

/**
 * Every target this guard refused, in order, on the global so a test can read it.
 *
 * A refusal does not always reach the caller as itself: `@composio/client` retries a rejected
 * transport and then reports "Connection error.", which is the same sentence a real outage would
 * produce, and a native `Bun.fetch` sees the refusing proxy's 403. So the fact that the guard —
 * rather than the network — stopped a call is recorded here at the point of refusal, where it is
 * unambiguous. `server/tests/test-network-guard.test.ts` reads it; nothing in `server/src` may.
 */
declare global {
  var openbotTestNetworkRefusals: string[] | undefined;
}

globalThis.openbotTestNetworkRefusals = [];

const explanation =
  "Tests do not use the network: stub the transport this call goes through (and stub it BEFORE " +
  "constructing any client, which binds `fetch` once), or, for a deliberate vendor suite, set an " +
  "OPENBOT_LIVE_* variable as `bun run test:live-*` does. Guard: server/scripts/test-network-guard.ts.";

function refuse(target: string): Error {
  globalThis.openbotTestNetworkRefusals?.push(target);
  return new Error(`A test tried to reach ${target}. ${explanation}`);
}

/** The host a Node `request`/`get`/`ClientRequest` call is aimed at, from any of its overloads. */
function nodeRequestHost(args: unknown[]): string {
  let host = "";
  const [first, second] = args;
  if (typeof first === "string") host = new URL(first).hostname;
  else if (first instanceof URL) host = first.hostname;
  for (const options of [first, second]) {
    if (options && typeof options === "object" && !(options instanceof URL)) {
      const { hostname, host: hostWithPort } = options as {
        hostname?: string | null;
        host?: string | null;
      };
      const named = hostname ?? hostWithPort;
      if (named) host = String(named).replace(/:\d+$/, "");
    }
  }
  return host;
}

/** The host a `net.Socket#connect` is aimed at; `null` for a Unix socket path, which is local. */
function socketConnectHost(args: unknown[]): string | null {
  const [first, second] = args;
  if (Array.isArray(first)) return socketConnectHost(first);
  if (first && typeof first === "object") {
    const options = first as { path?: string; host?: string };
    if (options.path) return null;
    return options.host ?? "localhost";
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null;
  return typeof second === "string" ? second : "localhost";
}

/**
 * Addresses no vendor can be behind, because the public internet does not route them: RFC 1918
 * private space, the RFC 5737 / RFC 3849 documentation ranges, and IPv6 unique-local space
 * (RFC 4193). Loopback is judged by `isLoopback`. Link-local (169.254/16, fe80::/10) is
 * deliberately NOT here: 169.254.169.254 is the cloud metadata service, which hands out credentials.
 */
const unroutable = new net.BlockList();
unroutable.addSubnet("10.0.0.0", 8, "ipv4");
unroutable.addSubnet("172.16.0.0", 12, "ipv4");
unroutable.addSubnet("192.168.0.0", 16, "ipv4");
unroutable.addSubnet("192.0.2.0", 24, "ipv4");
unroutable.addSubnet("198.51.100.0", 24, "ipv4");
unroutable.addSubnet("203.0.113.0", 24, "ipv4");
unroutable.addSubnet("fc00::", 7, "ipv6");
unroutable.addSubnet("2001:db8::", 32, "ipv6");

/** A LITERAL address that is loopback or that the public internet does not route. Never a name. */
function isUnroutableAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  const family = net.isIP(bare);
  if (family === 0) return false;
  return (
    isLoopback(bare) || unroutable.check(bare, family === 6 ? "ipv6" : "ipv4")
  );
}

/**
 * A name under a top-level domain RFC 6761 reserves so that public DNS never answers for it:
 * `.test`, `.invalid`, `.example` (`.localhost` is loopback already).
 *
 * BEING RESERVED IS NOT ENOUGH ON ITS OWN, so no entry point lets such a name through bare:
 * `/etc/hosts`, a local resolver, or a `lookup` option the caller hands in can map any name to any
 * address. A special-use name is let through only at `net.Socket#connect`, where its lookup is
 * replaced by `checkedLookup`, which judges the ADDRESS it resolves to by the same rule as a literal.
 */
function isSpecialUseName(host: string): boolean {
  return net.isIP(host) === 0 && /\.(test|invalid|example)\.?$/i.test(host);
}

function guardSocketHost(host: string | null, label: string): void {
  if (
    host === null ||
    isLoopback(host) ||
    isDatabaseHost(host) ||
    isUnroutableAddress(host)
  )
    return;
  throw refuse(`${label} ${host}`);
}

type LookupCallback = (
  error: Error | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;
type Lookup = (
  hostname: string,
  options: object | LookupCallback,
  callback?: LookupCallback,
) => void;

/**
 * The caller's `lookup` (or the system resolver), passed on only when every address it answers is
 * one `guardSocketHost` would let a literal through to. Otherwise the socket gets the refusal as its
 * connection error and never dials the address.
 */
function checkedLookup(lookup: Lookup | undefined): Lookup {
  const resolve = lookup ?? (dns.lookup as unknown as Lookup);
  return (hostname, options, callback) => {
    const done = (
      typeof options === "function" ? options : callback
    ) as LookupCallback;
    resolve(
      hostname,
      typeof options === "function" ? {} : options,
      (error, address, family) => {
        if (error) return done(error);
        const answered = Array.isArray(address)
          ? address.map((entry) => entry.address)
          : [String(address)];
        const far = answered.find(
          (candidate) => !isUnroutableAddress(candidate),
        );
        if (far !== undefined)
          return done(refuse(`socket ${hostname} resolved to ${far}`));
        done(null, address, family);
      },
    );
  };
}

/**
 * `net.Socket#connect` arguments aimed at a special-use name, rewritten with the lookup checked.
 * The overloads a name arrives in — `(options, cb)`, `(port, host, cb)`, and the pre-normalized
 * `[options, cb]` array Node's own `net.connect` passes — are covered. `null` for any other shape,
 * which `guardSocketHost` then refuses like any other name.
 */
function withCheckedLookup(args: unknown[]): unknown[] | null {
  const [first, second] = args;
  if (Array.isArray(first)) {
    // The normalized array is tagged by the runtime (a copy is not recognised as one and is
    // rejected as missing arguments), so it is rewritten in place rather than rebuilt.
    const inner = withCheckedLookup(first);
    if (!inner) return null;
    first.splice(0, first.length, ...inner);
    return args;
  }
  if (first && typeof first === "object") {
    const options = first as { lookup?: Lookup };
    return [
      { ...options, lookup: checkedLookup(options.lookup) },
      ...args.slice(1),
    ];
  }
  if (
    (typeof first === "number" || /^\d+$/.test(String(first))) &&
    typeof second === "string"
  ) {
    return [
      { port: Number(first), host: second, lookup: checkedLookup(undefined) },
      ...args.slice(2),
    ];
  }
  return null;
}

type Callable = (...args: unknown[]) => unknown;
type Constructable = new (...args: unknown[]) => object;

function replace(owner: object, key: string, value: unknown): void {
  (owner as Record<string, unknown>)[key] = value;
}

if (!liveRun) {
  /*
   * The refusing proxy, for every native fetch this file cannot wrap. `Bun.listen` binds
   * synchronously, so the port is known before the variables naming it are set, and the listener
   * is unreferenced so it never holds a finished run open.
   */
  const refusingProxy = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const [method = "", target = ""] = chunk
          .toString("latin1")
          .split("\r\n", 1)[0]
          .split(" ");
        refuse(
          method === "CONNECT"
            ? `https://${target.replace(/:443$/, "")}`
            : target.replace(/\?.*$/, ""),
        );
        const body = `Refused by the test network guard. ${explanation}`;
        socket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n" +
            "X-Openbot-Test-Network-Guard: refused\r\nContent-Type: text/plain\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      },
    },
  });
  refusingProxy.unref();
  const proxy = `http://127.0.0.1:${refusingProxy.port}`;
  const direct = "localhost,127.0.0.1,::1,[::1],0.0.0.0,.localhost";
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
    process.env[name] = proxy;
  for (const name of ["NO_PROXY", "no_proxy"]) process.env[name] = direct;

  const passThrough = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string } | null)?.url ?? String(input));
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      // A relative or unparseable target reaches no host; the runtime's own error is the right one.
    }
    if (url && /^(https?|wss?):$/.test(url.protocol)) {
      if (!isLoopback(url.hostname)) {
        return Promise.reject(refuse(url.origin + url.pathname));
      }
    }
    return passThrough(input as RequestInfo | URL, init);
  }) as typeof globalThis.fetch;

  /*
   * `request`, `get` and `ClientRequest` are forwarded through an `unknown[]` signature rather than
   * one of their overloads: nothing here reads an argument it did not already read off the first
   * two, and restating the overloads would be a declaration to maintain against Node's. `get` is
   * replaced on its own because the built-in calls its internal `request`, not this property.
   */
  for (const module of [http, https] as const) {
    for (const key of ["request", "get"] as const) {
      const original = module[key] as unknown as Callable;
      replace(module, key, (...args: unknown[]) => {
        const host = nodeRequestHost(args);
        if (!isLoopback(host)) throw refuse(host);
        return original(...args);
      });
    }
  }
  const OriginalClientRequest = http.ClientRequest as unknown as Constructable;
  replace(
    http,
    "ClientRequest",
    class GuardedClientRequest extends OriginalClientRequest {
      constructor(...args: unknown[]) {
        const host = nodeRequestHost(args);
        if (!isLoopback(host)) throw refuse(host);
        super(...args);
      }
    },
  );

  const originalSocketConnect = net.Socket.prototype.connect as Callable;
  replace(
    net.Socket.prototype,
    "connect",
    function (this: net.Socket, ...args: unknown[]) {
      const host = socketConnectHost(args);
      if (host !== null && isSpecialUseName(host) && !isDatabaseHost(host)) {
        const checked = withCheckedLookup(args);
        if (checked) return originalSocketConnect.apply(this, checked);
      }
      guardSocketHost(host, "socket");
      return originalSocketConnect.apply(this, args);
    },
  );

  const originalBunConnect = Bun.connect as unknown as Callable;
  // `Bun.connect` answers with a promise, so a refusal is a rejection rather than a throw.
  replace(Bun, "connect", (options: { hostname?: string; unix?: string }) => {
    try {
      guardSocketHost(
        options?.unix ? null : (options?.hostname ?? ""),
        "socket",
      );
    } catch (refusal) {
      return Promise.reject(refusal);
    }
    return originalBunConnect(options);
  });

  const originalHttp2Connect = http2.connect as unknown as Callable;
  replace(http2, "connect", (authority: unknown, ...rest: unknown[]) => {
    const host =
      authority instanceof URL
        ? authority.hostname
        : typeof authority === "string"
          ? new URL(authority).hostname
          : ((authority as { hostname?: string; host?: string } | null)
              ?.hostname ??
            (authority as { host?: string } | null)?.host ??
            "");
    if (!isLoopback(host)) throw refuse(`http2 ${host}`);
    return originalHttp2Connect(authority, ...rest);
  });

  const OriginalWebSocket = globalThis.WebSocket as unknown as Constructable;
  class GuardedWebSocket extends OriginalWebSocket {
    constructor(...args: unknown[]) {
      const url = new URL(String(args[0]));
      if (!isLoopback(url.hostname)) throw refuse(url.origin + url.pathname);
      super(...args);
    }
  }
  replace(globalThis, "WebSocket", GuardedWebSocket);
  replace(http, "WebSocket", GuardedWebSocket);
  for (const builtin of ["ws", "undici"]) {
    const module = require(builtin) as Record<string, unknown>;
    if (module.WebSocket) replace(module, "WebSocket", GuardedWebSocket);
  }

  const originalDgramSend = dgram.Socket.prototype.send as Callable;
  replace(
    dgram.Socket.prototype,
    "send",
    function (this: dgram.Socket, ...args: unknown[]) {
      // send(msg, port, address?, cb?) or send(msg, offset, length, port, address?, cb?)
      const address =
        typeof args[2] === "number" && typeof args[3] === "number"
          ? args[4]
          : args[2];
      if (typeof address === "string") guardSocketHost(address, "udp");
      return originalDgramSend.apply(this, args);
    },
  );
  const originalDgramConnect = dgram.Socket.prototype.connect as Callable;
  replace(
    dgram.Socket.prototype,
    "connect",
    function (this: dgram.Socket, ...args: unknown[]) {
      guardSocketHost(
        typeof args[1] === "string" ? args[1] : "localhost",
        "udp",
      );
      return originalDgramConnect.apply(this, args);
    },
  );

  const originalUdpSocket = Bun.udpSocket as unknown as Callable;
  replace(
    Bun,
    "udpSocket",
    async (options: { connect?: { hostname?: string } }) => {
      if (options?.connect)
        guardSocketHost(options.connect.hostname ?? "", "udp");
      const socket = (await originalUdpSocket(options)) as {
        send: Callable;
        sendMany: Callable;
      };
      const send = socket.send.bind(socket);
      socket.send = (...args: unknown[]) => {
        if (typeof args[2] === "string") guardSocketHost(args[2], "udp");
        return send(...args);
      };
      const sendMany = socket.sendMany.bind(socket);
      socket.sendMany = (packets: unknown) => {
        if (!options?.connect && Array.isArray(packets)) {
          for (let i = 2; i < packets.length; i += 3)
            guardSocketHost(String(packets[i]), "udp");
        }
        return sendMany(packets);
      };
      return socket;
    },
  );

  // Bun snapshots a built-in's named exports when it first loads; this re-reads every replacement
  // above into them, so `import { get } from "node:https"` in a test file is the guarded one.
  syncBuiltinESMExports();
}
