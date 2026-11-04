import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { createReleaseStatusRoutes } from "../src/release-status";

const keys = [
  "VERSION",
  "COMMIT",
  "DISTRIBUTION_ID",
  "REPOSITORY",
  "CHANNEL",
] as const;
const previous = new Map(
  keys.map((key) => [key, process.env[`OPENBOT_BUILD_${key}`]]),
);
afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[`OPENBOT_BUILD_${key}`];
    else process.env[`OPENBOT_BUILD_${key}`] = value;
  }
});
const identity = {
  version: "v0.3.0",
  commit: "3".repeat(40),
  distributionId: "acme.openbot",
  repository: "acme/openbot",
  channel: "stable",
};
function appWithBuild(env: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) {
    const value = env[key];
    if (value === undefined) delete process.env[`OPENBOT_BUILD_${key}`];
    else process.env[`OPENBOT_BUILD_${key}`] = value;
  }
  return createReleaseStatusRoutes();
}
function completeBuild() {
  return {
    VERSION: identity.version,
    COMMIT: identity.commit,
    DISTRIBUTION_ID: identity.distributionId,
    REPOSITORY: identity.repository,
    CHANNEL: identity.channel,
  };
}
/** What `http-server.ts` hands `app.fetch`: the Bun server, whose requestIP is the TCP peer. */
function from(address: string) {
  return { server: { requestIP: () => ({ address }) } };
}

describe("running release identity", () => {
  test("serves only the exact startup build identity to a loopback caller", async () => {
    const app = appWithBuild(completeBuild());
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const response = await app.request("/release", {}, from(address));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(identity);
    }
  });
  test.each([
    {},
    { ...completeBuild(), COMMIT: "invalid" },
    { ...completeBuild(), REPOSITORY: "bad repo" },
    { ...completeBuild(), CHANNEL: "" },
  ])("unknown or incomplete metadata returns 503", async (build) => {
    const app = appWithBuild(build);
    const response = await app.request("/release", {}, from("127.0.0.1"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Build release identity is unavailable",
    });
  });
  test("request headers and query parameters cannot supply release identity", async () => {
    const app = appWithBuild({});
    expect(
      (
        await app.request(
          "/release?version=v0.3.0",
          { headers: { "x-openbot-build-version": "v0.3.0" } },
          from("127.0.0.1"),
        )
      ).status,
    ).toBe(503);
  });
  test.each([
    ["another machine", from("10.20.30.40"), {}],
    ["no known peer", {}, {}],
    [
      "a proxy on this machine forwarding someone else",
      from("127.0.0.1"),
      { "x-forwarded-for": "203.0.113.9" },
    ],
    [
      "a proxy using the standard header",
      from("127.0.0.1"),
      { forwarded: "for=203.0.113.9" },
    ],
  ])("%s gets nothing about the build", async (_, env, headers) => {
    const app = appWithBuild(completeBuild());
    const response = await app.request("/release", { headers }, env);
    expect(response.status).toBe(404);
    const body = await response.text();
    for (const value of Object.values(identity))
      expect(body).not.toContain(value);
  });
});

// Through a real Bun server, wired as http-server.ts wires it, so the peer is the socket's. The
// request is a raw socket because the suite's network guard admits those to an RFC 1918 address
// (this machine's own), where it keeps `fetch` to loopback.
const outward = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) =>
      entry &&
      !entry.internal &&
      entry.family === "IPv4" &&
      /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address),
  );
function get(host: string, port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = connect({ host, port }, () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`,
      ),
    );
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () =>
      resolve({
        status: Number(text.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0),
        body: text.slice(text.indexOf("\r\n\r\n") + 4),
      }),
    );
  });
}
describe.skipIf(!outward)("release identity over a real socket", () => {
  test("loopback gets the identity and this machine's network address gets a 404", async () => {
    const app = appWithBuild(completeBuild());
    for (const [hostname, status] of [
      ["127.0.0.1", 200],
      [outward?.address ?? "", 404],
    ] as const) {
      const server = Bun.serve({
        hostname,
        port: 0,
        fetch: (request, server) => app.fetch(request, { server }),
      });
      try {
        const response = await get(hostname, server.port ?? 0, "/release");
        expect(response.status).toBe(status);
        expect(response.body.includes(identity.repository)).toBe(
          status === 200,
        );
      } finally {
        await server.stop(true);
      }
    }
  });
});
