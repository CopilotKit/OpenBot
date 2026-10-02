import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import {
  egressDecision,
  egressFor,
  handleEgressPolicyRequest,
  parseEgressPolicy,
  parseEgressRules,
  setEgressPolicy,
  setEgressResolver,
  startEgressFilter,
  stopEgressFilter,
} from "../src/egress";

describe("the network policy rules", () => {
  test("allow_all and deny_all ignore the rules", () => {
    expect(
      egressDecision({ mode: "allow_all", rules: [] }, "x.test", 443).allowed,
    ).toBe(true);
    expect(
      egressDecision(
        { mode: "deny_all", rules: [{ type: "domain", value: "x.test" }] },
        "x.test",
        443,
      ).allowed,
    ).toBe(false);
  });

  test("a domain rule covers the domain and its subdomains, a wildcard only subdomains", () => {
    const policy = {
      mode: "allowlist_only" as const,
      rules: [
        { type: "domain" as const, value: "example.com" },
        { type: "domain" as const, value: "*.corp.test" },
      ],
    };
    expect(egressDecision(policy, "example.com", 443).allowed).toBe(true);
    expect(egressDecision(policy, "API.Example.com.", 443).allowed).toBe(true);
    expect(egressDecision(policy, "notexample.com", 443).allowed).toBe(false);
    expect(egressDecision(policy, "a.corp.test", 443).allowed).toBe(true);
    expect(egressDecision(policy, "corp.test", 443).allowed).toBe(false);
  });

  test("defaults are only added by defaults_plus_allowlist", () => {
    expect(
      egressDecision(
        { mode: "defaults_plus_allowlist", rules: [] },
        "registry.npmjs.org",
        443,
      ).allowed,
    ).toBe(true);
    expect(
      egressDecision(
        { mode: "allowlist_only", rules: [] },
        "registry.npmjs.org",
        443,
      ).allowed,
    ).toBe(false);
  });

  test("an IP range rule matches addresses and ports, and every resolved address must match", () => {
    const policy = {
      mode: "allowlist_only" as const,
      rules: [
        { type: "cidr" as const, value: "10.0.0.0/8", ports: "5432,8000-8100" },
      ],
    };
    expect(egressDecision(policy, "10.1.2.3", 5432).allowed).toBe(true);
    expect(egressDecision(policy, "10.1.2.3", 8050).allowed).toBe(true);
    expect(egressDecision(policy, "10.1.2.3", 22).allowed).toBe(false);
    expect(egressDecision(policy, "11.0.0.1", 5432).allowed).toBe(false);
    expect(
      egressDecision(policy, "db.internal", 5432, ["10.0.0.9"]).allowed,
    ).toBe(true);
    // Partly outside the range is refused, not connected to the first answer.
    expect(
      egressDecision(policy, "db.internal", 5432, ["10.0.0.9", "8.8.8.8"])
        .allowed,
    ).toBe(false);
    expect(egressDecision(policy, "db.internal", 5432, []).allowed).toBe(false);
  });

  test("IPv6 ranges work", () => {
    const policy = {
      mode: "allowlist_only" as const,
      rules: [{ type: "cidr" as const, value: "fd00::/8" }],
    };
    expect(egressDecision(policy, "[fd00::1]", 443).allowed).toBe(true);
    expect(egressDecision(policy, "2001:db8::1", 443).allowed).toBe(false);
  });

  test("malformed rules are refused with a sentence, not stored", () => {
    expect(
      parseEgressRules([{ type: "domain", value: "not a domain" }]).ok,
    ).toBe(false);
    expect(parseEgressRules([{ type: "cidr", value: "10.0.0.0/33" }]).ok).toBe(
      false,
    );
    expect(
      parseEgressRules([{ type: "cidr", value: "10.0.0.0/8", ports: "80;443" }])
        .ok,
    ).toBe(false);
    expect(parseEgressPolicy({ mode: "sometimes", rules: [] }).ok).toBe(false);
    expect(
      parseEgressRules([
        { type: "domain", value: "Example.COM" },
        { type: "cidr", value: "192.168.0.0/16", ports: "443, 8443" },
      ]),
    ).toEqual({
      ok: true,
      rules: [
        { type: "domain", value: "example.com" },
        { type: "cidr", value: "192.168.0.0/16", ports: "443,8443" },
      ],
    });
  });
});

/**
 * The filter, driven over real sockets on 127.0.0.1: a policy pushed while it runs applies to the
 * next connection without restarting anything.
 */
describe("the filter proxy", () => {
  afterEach(async () => {
    await stopEgressFilter();
    setEgressResolver(null);
  });

  async function origin() {
    const server = createServer((_request, response) =>
      response.end("reached"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    return {
      port: typeof address === "object" && address ? address.port : 0,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function connectThrough(
    filterPort: number,
    target: string,
    botId?: string,
    secret?: string,
  ) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(filterPort, "127.0.0.1", () => {
        const auth =
          botId && secret
            ? `Proxy-Authorization: Basic ${Buffer.from(`${botId}:${secret}`).toString("base64")}\r\n`
            : "";
        socket.write(
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`,
        );
      });
      let seen = "";
      socket.on("data", (chunk) => {
        seen += chunk.toString();
        if (seen.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(seen.split("\r\n")[0] ?? "");
        }
      });
      socket.on("error", reject);
    });
  }

  test("the browser is pointed at the filter with the Bot in its credentials", async () => {
    const filter = await startEgressFilter({ env: {} });
    const proxy = egressFor("sales", {});
    expect(proxy?.server).toBe(`http://127.0.0.1:${filter.port}`);
    expect(proxy?.username).toBe("sales");
    expect(proxy?.password?.length).toBeGreaterThan(10);
  });

  test("a pushed policy applies to the next connection, live", async () => {
    const target = await origin();
    const filter = await startEgressFilter({ env: {} });
    const secret = egressFor("sales", {})?.password;

    // Nothing pushed yet: refused, so a computer that just started or woke is not unfiltered.
    expect(
      await connectThrough(
        filter.port,
        `127.0.0.1:${target.port}`,
        "sales",
        secret,
      ),
    ).toContain("403");

    const pushed = await handleEgressPolicyRequest(
      "sales",
      new Request("http://computer/egress-policy", {
        method: "PUT",
        body: JSON.stringify({ policy: { mode: "allowlist_only", rules: [] } }),
      }),
    );
    expect(pushed.status).toBe(200);
    expect(
      await connectThrough(
        filter.port,
        `127.0.0.1:${target.port}`,
        "sales",
        secret,
      ),
    ).toContain("403");

    setEgressPolicy("sales", {
      mode: "allowlist_only",
      rules: [
        { type: "cidr", value: "127.0.0.1/32", ports: String(target.port) },
      ],
    });
    expect(
      await connectThrough(
        filter.port,
        `127.0.0.1:${target.port}`,
        "sales",
        secret,
      ),
    ).toContain("200");
    await target.close();
  });

  test("with nothing pushed, every connection is refused, a shell's included", async () => {
    const target = await origin();
    const filter = await startEgressFilter({ env: {} });
    const secret = egressFor("sales", {})?.password;
    expect(
      await connectThrough(
        filter.port,
        `127.0.0.1:${target.port}`,
        "sales",
        secret,
      ),
    ).toContain("403");
    expect(
      await connectThrough(filter.port, `127.0.0.1:${target.port}`),
    ).toContain("403");
    await target.close();
  });

  test("EGRESS_POLICY_REQUIRED=0 lets a computer with no server browse before a push", async () => {
    const target = await origin();
    const filter = await startEgressFilter({
      env: { EGRESS_POLICY_REQUIRED: "0" },
    });
    expect(
      await connectThrough(filter.port, `127.0.0.1:${target.port}`),
    ).toContain("200");
    await target.close();
  });

  test("cloud metadata and link-local addresses are refused under every policy, allow_all included", async () => {
    const filter = await startEgressFilter({ env: {} });
    const secret = egressFor("sales", {})?.password;
    setEgressPolicy("sales", { mode: "allow_all", rules: [] });
    for (const target of [
      "169.254.169.254:80",
      "[fd00:ec2::254]:80",
      "[fd20:ce::254]:80",
      "100.100.100.200:80",
      "[::ffff:169.254.169.254]:80",
      "[fe80::1]:80",
    ]) {
      expect(
        await connectThrough(filter.port, target, "sales", secret),
      ).toContain("403");
    }
    // A name is judged by what it resolves to.
    setEgressResolver(async (host) =>
      host === "metadata.example.test" ? ["169.254.169.254"] : [],
    );
    expect(
      await connectThrough(
        filter.port,
        "metadata.example.test:80",
        "sales",
        secret,
      ),
    ).toContain("403");
  });

  test("a plain HTTP request goes to the address that was checked, not a second lookup", async () => {
    const target = await origin();
    const filter = await startEgressFilter({ env: {} });
    const secret = egressFor("sales", {})?.password;
    setEgressPolicy("sales", {
      mode: "allowlist_only",
      rules: [
        { type: "cidr", value: "127.0.0.1/32", ports: String(target.port) },
      ],
    });
    // Only this stub knows the name: a connection made by name would ask the system resolver
    // again, which cannot answer, and fail.
    setEgressResolver(async (host) =>
      host === "rebind.example.test" ? ["127.0.0.1"] : [],
    );
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(filter.port, "127.0.0.1", () => {
        socket.write(
          `GET http://rebind.example.test:${target.port}/ HTTP/1.1\r\nHost: rebind.example.test:${target.port}\r\nProxy-Authorization: Basic ${Buffer.from(`sales:${secret}`).toString("base64")}\r\nConnection: close\r\n\r\n`,
        );
      });
      let seen = "";
      socket.on("data", (chunk) => {
        seen += chunk.toString();
      });
      socket.on("end", () => resolve(seen));
      socket.on("error", reject);
    });
    expect(answer.split("\r\n")[0]).toContain("200");
    expect(answer).toContain("reached");
    await target.close();
  });

  // A name with an address the computer cannot reach first (here ::1, where nothing listens) and a
  // reachable one second: the connection has to fall back to the next checked address, as Node's
  // own connect does, instead of failing on the first.
  async function dualStack() {
    const target = await origin();
    const filter = await startEgressFilter({ env: {} });
    const secret = egressFor("sales", {})?.password ?? "";
    setEgressPolicy("sales", {
      mode: "allowlist_only",
      rules: [{ type: "domain", value: "dual.example.test" }],
    });
    setEgressResolver(async (host) =>
      host === "dual.example.test" ? ["::1", "127.0.0.1"] : [],
    );
    return { target, filter, secret };
  }

  test("a plain HTTP request falls back to the next checked address", async () => {
    const { target, filter, secret } = await dualStack();
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(filter.port, "127.0.0.1", () => {
        socket.write(
          `GET http://dual.example.test:${target.port}/ HTTP/1.1\r\nHost: dual.example.test:${target.port}\r\nProxy-Authorization: Basic ${Buffer.from(`sales:${secret}`).toString("base64")}\r\nConnection: close\r\n\r\n`,
        );
      });
      let seen = "";
      socket.on("data", (chunk) => {
        seen += chunk.toString();
      });
      socket.on("end", () => resolve(seen));
      socket.on("error", reject);
    });
    expect(answer.split("\r\n")[0]).toContain("200");
    expect(answer).toContain("reached");
    await target.close();
  });

  test("a CONNECT tunnel falls back to the next checked address", async () => {
    const { target, filter, secret } = await dualStack();
    expect(
      await connectThrough(
        filter.port,
        `dual.example.test:${target.port}`,
        "sales",
        secret,
      ),
    ).toContain("200");
    await target.close();
  });

  test("a forwarded plain-HTTP request leaves once, not back into the filter", async () => {
    let reached = 0;
    const server = createServer((_request, response) => {
      reached += 1;
      response.end("reached");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // As the computer starts it: the shell pointed at the filter.
    const filter = await startEgressFilter({ env: {}, forShell: true });
    setEgressPolicy("sales", { mode: "allow_all", rules: [] });
    const secret = egressFor("sales", {})?.password;
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = connect(filter.port, "127.0.0.1", () => {
          socket.write(
            `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: Basic ${Buffer.from(`sales:${secret}`).toString("base64")}\r\nConnection: close\r\n\r\n`,
          );
        });
        let seen = "";
        socket.setTimeout(5_000, () => socket.destroy(new Error("timed out")));
        socket.on("data", (chunk) => {
          seen += chunk.toString();
        });
        socket.on("end", () => resolve(seen));
        socket.on("error", reject);
      });
      expect(answer).toContain("reached");
      expect(reached).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("the shell is pointed at the filter, and this process is not", async () => {
    const { egressShellEnvironment } = await import("../src/egress");
    const before = process.env.HTTP_PROXY;
    const filter = await startEgressFilter({ env: {}, forShell: true });
    expect(egressShellEnvironment().HTTP_PROXY).toBe(filter.url);
    expect(egressShellEnvironment().NO_PROXY).toContain("127.0.0.1");
    expect(process.env.HTTP_PROXY).toBe(before);
    await stopEgressFilter();
    expect(egressShellEnvironment()).toEqual({});
  });

  test("an anonymous connection is judged by every policy on the computer", async () => {
    const target = await origin();
    const filter = await startEgressFilter({ env: {} });
    setEgressPolicy("a", { mode: "allow_all", rules: [] });
    setEgressPolicy("b", { mode: "deny_all", rules: [] });
    expect(
      await connectThrough(filter.port, `127.0.0.1:${target.port}`),
    ).toContain("403");
    await target.close();
  });

  test("EGRESS_POLICY_REQUIRED=1 still refuses until a policy arrives", async () => {
    const target = await origin();
    const filter = await startEgressFilter({
      env: { EGRESS_POLICY_REQUIRED: "1" },
    });
    const secret = egressFor("sales", {})?.password;
    expect(
      await connectThrough(
        filter.port,
        `127.0.0.1:${target.port}`,
        "sales",
        secret,
      ),
    ).toContain("403");
    await target.close();
  });

  test("a bad push is refused and changes nothing", async () => {
    const answer = await handleEgressPolicyRequest(
      "sales",
      new Request("http://computer/egress-policy", {
        method: "PUT",
        body: JSON.stringify({
          policy: { mode: "allowlist_only", rules: [{ type: "x" }] },
        }),
      }),
    );
    expect(answer.status).toBe(400);
  });
});
