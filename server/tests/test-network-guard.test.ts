import { describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import http, { request as namedHttpRequest } from "node:http";
import http2 from "node:http2";
import https, { get as namedHttpsGet } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createComposioClient } from "../src/plugins/composio-adapter";

/**
 * The guard that makes a live vendor call impossible, asserted rather than assumed — ONE ENTRY
 * POINT AT A TIME.
 *
 * `server/scripts/test-network-guard.ts` runs from the preload, before any test file is imported.
 * Its first version patched `globalThis.fetch` and `http(s).request` only, and this file asserted
 * it through `fetch` only, so it stayed green while `https.get` returned 200 from example.com and
 * `Bun.fetch` was not guarded at all. A guard is exactly as wide as the entry points its test
 * plants a call through, so every entry point a test file could open a connection with is planted
 * below, separately, and each one must end in a refusal the GUARD recorded during THAT call.
 *
 * Why the record rather than the error: a refusal does not always reach the caller as itself (the
 * Composio SDK retries and says "Connection error.", and a native `Bun.fetch` sees the refusing
 * proxy's 403), and an error alone cannot tell a guarded call from a dialled one that failed. Why
 * only the entries recorded during the call: the record is process-wide, so a check against the
 * whole of it would be satisfied by whichever earlier test happened to be refused.
 *
 * example.com is the far side throughout: the assertion is that NOTHING is dialled, so the address
 * should be one no product code would ever have reason to reach.
 */

const FAR = "example.com";

/** Runs one planted call and returns what it came to and what the guard recorded while it ran. */
async function plant(
  call: () => unknown,
): Promise<{ outcome: string; refused: string[] }> {
  const record = globalThis.openbotTestNetworkRefusals;
  if (!record) throw new Error("the network guard did not install its record");
  const before = record.length;
  let outcome: string;
  try {
    const value = await call();
    outcome =
      value instanceof Response
        ? `response ${value.status} ${value.headers.get("x-openbot-test-network-guard") ?? "unguarded"}`
        : "returned";
  } catch (error) {
    outcome = `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { outcome, refused: record.slice(before) };
}

const refusedCall = "Tests do not use the network";

/**
 * What a caller of a NATIVE fetch sees when the refusing proxy turns it away. That text is not the
 * guard's: over https the runtime reports the proxy's 403 itself, and how it words it differs by
 * platform and version (macOS bun 1.4.2 hands back the guard's own 403 response; CI's Linux runner
 * throws "Proxy refused to open a tunnel: 403 Forbidden"). So the outcome is pinned only as far as
 * the guard owns it: EITHER the guard's own 403, carrying its header, OR a throw — never a response
 * the guard did not write. A call that had really been dialled ends in such a response (the red at
 * the C7 base was "response 404 unguarded"). That the GUARD stopped it is then asserted on the
 * guard's record, which its proxy writes only when the request was handed to it.
 */
const refusedByProxy = /^(response 403 refused|threw: .+)$/s;

/** Each entry point, the call it plants, the outcome the caller sees and the target recorded. */
const entryPoints: Array<[string, () => unknown, string | RegExp, string]> = [
  [
    "globalThis.fetch",
    () => fetch(`https://${FAR}/x`),
    refusedCall,
    `https://${FAR}/x`,
  ],
  [
    "Bun.fetch",
    () => Bun.fetch(`https://${FAR}/x`),
    refusedByProxy,
    `https://${FAR}`,
  ],
  [
    "Bun.fetch over http",
    () => Bun.fetch(`http://${FAR}/x`),
    refusedByProxy,
    `http://${FAR}/x`,
  ],
  [
    "undici fetch",
    () =>
      (require("undici") as { fetch: typeof fetch }).fetch(`https://${FAR}/x`),
    refusedByProxy,
    `https://${FAR}`,
  ],
  [
    "undici request",
    async () => {
      const { statusCode, headers } = await (
        require("undici") as {
          request: (url: string) => Promise<{
            statusCode: number;
            headers: Record<string, string>;
          }>;
        }
      ).request(`https://${FAR}/x`);
      return new Response(null, { status: statusCode, headers });
    },
    refusedByProxy,
    `https://${FAR}`,
  ],
  ["http.request", () => http.request(`http://${FAR}/x`), refusedCall, FAR],
  [
    "https.request",
    () => https.request({ hostname: FAR, path: "/x" }),
    refusedCall,
    FAR,
  ],
  ["http.get", () => http.get(`http://${FAR}/x`), refusedCall, FAR],
  ["https.get", () => https.get(`https://${FAR}/x`), refusedCall, FAR],
  [
    "named import of https.get",
    () => namedHttpsGet(`https://${FAR}/x`),
    refusedCall,
    FAR,
  ],
  [
    "http.ClientRequest",
    () => new http.ClientRequest(`http://${FAR}/x`),
    refusedCall,
    FAR,
  ],
  ["net.connect", () => net.connect(80, FAR), refusedCall, `socket ${FAR}`],
  [
    "net.Socket#connect",
    () => new net.Socket().connect({ host: FAR, port: 80 }),
    refusedCall,
    `socket ${FAR}`,
  ],
  [
    "tls.connect",
    () => tls.connect(443, FAR, { servername: FAR }),
    refusedCall,
    `socket ${FAR}`,
  ],
  [
    "Bun.connect",
    () => Bun.connect({ hostname: FAR, port: 80, socket: { data() {} } }),
    refusedCall,
    `socket ${FAR}`,
  ],
  [
    "http2.connect",
    () => http2.connect(`https://${FAR}`),
    refusedCall,
    `http2 ${FAR}`,
  ],
  [
    "WebSocket",
    () => new WebSocket(`wss://${FAR}/x`),
    refusedCall,
    `wss://${FAR}/x`,
  ],
  [
    "ws WebSocket",
    () =>
      new (require("ws") as { WebSocket: typeof WebSocket }).WebSocket(
        `wss://${FAR}/x`,
      ),
    refusedCall,
    `wss://${FAR}/x`,
  ],
  [
    "dgram send",
    () => {
      const socket = dgram.createSocket("udp4");
      try {
        socket.send("x", 9, FAR);
      } finally {
        socket.close();
      }
    },
    refusedCall,
    `udp ${FAR}`,
  ],
  [
    "Bun.udpSocket send",
    async () => {
      const socket = await Bun.udpSocket({});
      try {
        socket.send("x", 9, FAR);
      } finally {
        socket.close();
      }
    },
    refusedCall,
    `udp ${FAR}`,
  ],
];

describe("the test network guard refuses a host that is not loopback, through", () => {
  test.each(entryPoints)("%s", async (_name, call, seen, target) => {
    const { outcome, refused } = await plant(call);

    // A string is matched as a substring, a pattern as itself.
    expect(outcome).toMatch(seen);
    expect(refused).toEqual([target]);
  });
});

describe("the test network guard lets the suite reach what the suite owns", () => {
  test("a loopback HTTP server, through fetch, Bun.fetch and node:http", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("local") });
    try {
      const { outcome, refused } = await plant(async () => {
        const answers = [
          await (await fetch(`http://127.0.0.1:${server.port}/`)).text(),
          await (await Bun.fetch(`http://localhost:${server.port}/`)).text(),
          await new Promise<string>((resolve, reject) => {
            http
              .get(`http://127.0.0.1:${server.port}/`, (response) => {
                let body = "";
                response.on("data", (chunk) => (body += chunk));
                response.on("end", () => resolve(body));
              })
              .on("error", reject);
          }),
        ];
        return answers.join(",");
      });

      expect(outcome).toBe("returned");
      expect(refused).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("a loopback socket, through net.connect", async () => {
    const listener = net.createServer((socket) => socket.end("local"));
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as net.AddressInfo;
    try {
      const { outcome, refused } = await plant(
        () =>
          new Promise<string>((resolve, reject) => {
            const socket = net.connect(port, "127.0.0.1");
            let body = "";
            socket.on("data", (chunk) => (body += chunk));
            socket.on("end", () => resolve(body));
            socket.on("error", reject);
          }),
      );

      expect(outcome).toBe("returned");
      expect(refused).toEqual([]);
    } finally {
      listener.close();
    }
  });

  /**
   * The database is the one far NAME a raw socket may reach without its lookup being checked,
   * because it is deployment configuration rather than a vendor. `home.arpa` (RFC 8375) never
   * resolves in public DNS, so the connection fails in DNS — and the point is that it got as far as
   * DNS instead of being refused. Not `.invalid`: that is a special-use name the guard lets through
   * on its own terms, so a case aimed at one could not tell whether the database allowance exists.
   */
  test("the configured database host, through a raw socket", async () => {
    const configured = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL =
      "postgres://u:p@db.openbot.home.arpa:5432/x";
    try {
      const { outcome, refused } = await plant(
        () =>
          new Promise<void>((_resolve, reject) => {
            net.connect(5432, "db.openbot.home.arpa").on("error", reject);
          }),
      );

      expect(outcome).not.toContain(refusedCall);
      expect(refused).toEqual([]);
    } finally {
      if (configured === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = configured;
    }
  });
});

/**
 * A suite whose SUBJECT is the socket layer — `agent-computer`'s egress filter, which proves it
 * pins the address it checked, falls back, and gives up on one that never answers — has to open
 * sockets at addresses that are not loopback. The guard lets through only what cannot be a vendor:
 * a literal address the public internet does not route, and a reserved special-use name (RFC 6761)
 * ONLY when what it resolves to is such an address. Each allowance is planted next to the far
 * address it must still refuse, so widening it into "anything goes" turns these red.
 */
describe("the test network guard judges a socket by the address it reaches", () => {
  /** A `lookup` that answers one address, in both shapes the runtime asks for (Bun asks `all`). */
  function answering(address: string): net.LookupFunction {
    return (_host, options, callback) =>
      options.all
        ? callback(null, [{ address, family: 4 }])
        : callback(null, address, 4);
  }

  /** Settles on connect, on a short wait (an unroutable address may hang), or rejects on error. */
  function dial(open: () => net.Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = open();
      const timer = setTimeout(() => {
        socket.destroy();
        resolve("pending");
      }, 200);
      socket.once("connect", () => {
        clearTimeout(timer);
        const reached = `connected ${socket.remoteAddress}`;
        socket.destroy();
        resolve(reached);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
  }

  test("an unroutable private address is let through; a public one and the metadata service are not", async () => {
    const privately = await plant(() =>
      dial(() => net.connect({ host: "10.255.255.1", port: 9 })),
    );
    expect(privately.outcome).not.toContain(refusedCall);
    expect(privately.refused).toEqual([]);

    const publicly = await plant(() =>
      dial(() => net.connect({ host: "93.184.215.14", port: 80 })),
    );
    expect(publicly.outcome).toContain(refusedCall);
    expect(publicly.refused).toEqual(["socket 93.184.215.14"]);

    const metadata = await plant(() =>
      dial(() => net.connect({ host: "169.254.169.254", port: 80 })),
    );
    expect(metadata.outcome).toContain(refusedCall);
    expect(metadata.refused).toEqual(["socket 169.254.169.254"]);
  });

  test("a .test name is let through when its lookup answers loopback", async () => {
    const listener = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as net.AddressInfo;
    try {
      let reached = "";
      const { refused } = await plant(async () => {
        reached = await dial(() =>
          net.connect({
            host: "pinned.example.test",
            port,
            lookup: answering("127.0.0.1"),
          }),
        );
      });

      expect(reached).toBe("connected 127.0.0.1");
      expect(refused).toEqual([]);
    } finally {
      listener.close();
    }
  });

  /*
   * A reserved name is only reserved in PUBLIC DNS: a `lookup` option (or /etc/hosts) can map it to
   * any address at all, which is exactly how a test could smuggle a vendor's address past a
   * name-based allowance. Planted through the socket and through a named `node:http` import, which
   * the request-layer patch does not reach and which therefore meets only the socket guard.
   */
  const smuggle = answering("93.184.215.14");

  test.each<[string, () => Promise<unknown>]>([
    [
      "net.connect",
      () =>
        dial(() =>
          net.connect({
            host: "smuggled.example.test",
            port: 80,
            lookup: smuggle,
          }),
        ),
    ],
    [
      "a named import of http.request",
      () =>
        new Promise((resolve, reject) => {
          namedHttpRequest({
            host: "smuggled.example.test",
            port: 80,
            lookup: smuggle,
          })
            .on("response", () => resolve("answered"))
            .on("error", reject)
            .end();
        }),
    ],
  ])(
    "a .test name whose lookup answers a public address is refused, through %s",
    async (_name, call) => {
      const { outcome, refused } = await plant(call);

      expect(outcome).toContain(refusedCall);
      expect(refused).toEqual([
        "socket smuggled.example.test resolved to 93.184.215.14",
      ]);
    },
  );
});

/**
 * The case the guard was written for, in the shape that defeated the per-file stub: the vendor
 * client is constructed with no stub in sight, and its own bound transport is the guard.
 */
test("the test network guard is in force for a vendor SDK that binds its own transport", async () => {
  const { broker } = createComposioClient("never-dialled");

  const { outcome, refused } = await plant(() =>
    broker.authorize({
      account: { holder: "person", userId: "u", vendorUserId: "u" },
      toolkit: "linear",
      returnUrl: "https://openbot.test/connections/x",
    }),
  );

  expect(outcome).not.toBe("returned");
  /*
   * ASSERTED ON THE GUARD'S OWN RECORD RATHER THAN THE MESSAGE, because the SDK retries the
   * rejected transport and reports "Connection error." — the same sentence a real outage gives,
   * so a test that read it could not tell a guarded call from a dialled one that failed.
   */
  expect(refused.length).toBeGreaterThan(0);
  expect(
    refused.every((target) => target.includes("backend.composio.dev")),
  ).toBe(true);
});
