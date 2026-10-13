import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import {
  egressFor,
  egressLabel,
  setEgressPolicy,
  startEgressFilter,
  stopEgressFilter,
} from "../src/egress";

/**
 * A residential or ISP proxy, end to end: a Bot's request through the egress filter, the filter
 * through a credentialed upstream, the upstream to the site.
 *
 * The upstream here behaves as the commercial gateways do: `407` with `Proxy-Authenticate` to anything
 * without the right Basic credentials, for plain HTTP and for CONNECT alike. What has to hold is that
 * the credentials in `EGRESS_PROXY_DEFAULT` reach it (percent-encoded characters decoded), that the
 * Bot's own filter credentials do not, that the network policy is decided before the upstream is ever
 * asked, and that the password appears nowhere a person would read it.
 */

const USER = "customer-acme-country-us";
const PASSWORD = "p@ss:w0rd/with%chars";
const PROXY_URL = (port: number) =>
  `http://${USER}:${encodeURIComponent(PASSWORD)}@127.0.0.1:${port}`;
const EXPECTED = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;

type Upstream = {
  port: number;
  seen: { method: string; target: string; authorization?: string }[];
  close: () => Promise<void>;
};

async function residentialGateway(): Promise<Upstream> {
  const seen: Upstream["seen"] = [];
  const server = createServer((request, response) => {
    const authorization = request.headers["proxy-authorization"];
    seen.push({
      method: request.method ?? "",
      target: request.url ?? "",
      ...(authorization ? { authorization } : {}),
    });
    if (authorization !== EXPECTED) {
      response
        .writeHead(407, { "proxy-authenticate": 'Basic realm="residential"' })
        .end();
      return;
    }
    response.end(`via residential: ${request.url}`);
  });
  server.on("connect", (request: IncomingMessage, client: Socket) => {
    const authorization = request.headers["proxy-authorization"];
    seen.push({
      method: "CONNECT",
      target: request.url ?? "",
      ...(authorization ? { authorization } : {}),
    });
    if (authorization !== EXPECTED) {
      client.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="residential"\r\n\r\n',
      );
      return;
    }
    const [host = "", port = "0"] = (request.url ?? "").split(":");
    const remote = connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      remote.pipe(client);
      client.pipe(remote);
    });
    remote.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function site() {
  const server = createServer((request, response) =>
    response.end(`site answered ${request.url}`),
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Send raw bytes to the filter as the Bot's browser does, with the Bot's own proxy credentials. */
function throughFilter(bot: string, payload: (auth: string) => string) {
  const egress = egressFor(bot, {});
  if (!egress?.username) throw new Error("the filter is not running");
  const auth = `Basic ${Buffer.from(`${egress.username}:${egress.password}`).toString("base64")}`;
  const port = Number(new URL(egress.server).port);
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(payload(auth)),
    );
    let answer = "";
    socket.on("data", (chunk) => {
      answer += String(chunk);
    });
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(answer);
    }, 3_000);
  });
}

describe("a residential proxy behind the egress filter", () => {
  afterEach(async () => {
    await stopEgressFilter();
  });

  test("plain HTTP reaches the site with the proxy's credentials, not the Bot's", async () => {
    const gateway = await residentialGateway();
    const target = await site();
    await startEgressFilter({
      env: { EGRESS_PROXY_DEFAULT: PROXY_URL(gateway.port) },
    });
    setEgressPolicy("sales", { mode: "allow_all", rules: [] });
    try {
      const answer = await throughFilter(
        "sales",
        (auth) =>
          `GET http://127.0.0.1:${target.port}/page HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`,
      );
      expect(answer).toContain(
        `via residential: http://127.0.0.1:${target.port}/page`,
      );
      expect(gateway.seen).toEqual([
        {
          method: "GET",
          target: `http://127.0.0.1:${target.port}/page`,
          authorization: EXPECTED,
        },
      ]);
    } finally {
      await gateway.close();
      await target.close();
    }
  });

  test("HTTPS goes through as a CONNECT carrying the proxy's credentials", async () => {
    const gateway = await residentialGateway();
    const target = await site();
    await startEgressFilter({
      env: { EGRESS_PROXY_DEFAULT: PROXY_URL(gateway.port) },
    });
    setEgressPolicy("sales", { mode: "allow_all", rules: [] });
    try {
      const answer = await throughFilter(
        "sales",
        (auth) =>
          `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nProxy-Authorization: ${auth}\r\n\r\nGET /secure HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(answer).toContain("200 Connection Established");
      expect(answer).toContain("site answered /secure");
      expect(gateway.seen).toEqual([
        {
          method: "CONNECT",
          target: `127.0.0.1:${target.port}`,
          authorization: EXPECTED,
        },
      ]);
    } finally {
      await gateway.close();
      await target.close();
    }
  });

  test("wrong credentials are the gateway's refusal, passed back rather than retried around", async () => {
    const gateway = await residentialGateway();
    const target = await site();
    await startEgressFilter({
      env: {
        EGRESS_PROXY_DEFAULT: `http://${USER}:wrong@127.0.0.1:${gateway.port}`,
      },
    });
    setEgressPolicy("sales", { mode: "allow_all", rules: [] });
    try {
      const answer = await throughFilter(
        "sales",
        (auth) =>
          `GET http://127.0.0.1:${target.port}/page HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`,
      );
      expect(answer).not.toContain("site answered");
      expect(answer).toMatch(/^HTTP\/1\.1 (407|502)/);
    } finally {
      await gateway.close();
      await target.close();
    }
  });

  test("the network policy is decided first: a refused destination never reaches the gateway", async () => {
    const gateway = await residentialGateway();
    await startEgressFilter({
      env: { EGRESS_PROXY_DEFAULT: PROXY_URL(gateway.port) },
    });
    setEgressPolicy("sales", {
      mode: "allowlist_only",
      rules: [{ type: "domain", value: "allowed.example" }],
    });
    try {
      const plain = await throughFilter(
        "sales",
        (auth) =>
          `GET http://refused.example/ HTTP/1.1\r\nHost: refused.example\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`,
      );
      const tunnel = await throughFilter(
        "sales",
        (auth) =>
          `CONNECT refused.example:443 HTTP/1.1\r\nHost: refused.example:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
      );
      expect(plain).toStartWith("HTTP/1.1 403");
      expect(tunnel).toStartWith("HTTP/1.1 403");
      expect(gateway.seen).toEqual([]);
    } finally {
      await gateway.close();
    }
  });

  test("the password is in nothing a person reads", () => {
    const egress = egressFor("sales", {
      EGRESS_PROXY_DEFAULT: PROXY_URL(8000),
    });
    expect(egress?.server).toBe("http://127.0.0.1:8000");
    expect(egress?.password).toBe(PASSWORD);
    const label = JSON.stringify(
      egressLabel("sales", { EGRESS_PROXY_DEFAULT: PROXY_URL(8000) }),
    );
    expect(label).not.toContain("w0rd");
    expect(label).not.toContain(encodeURIComponent(PASSWORD));
  });
});
