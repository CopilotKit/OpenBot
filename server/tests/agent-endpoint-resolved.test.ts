import { describe, expect, test } from "bun:test";
import {
  checkResolvedAgentHost,
  createAgentFetch,
  EndpointNotAllowedError,
  trustedHostsOf,
} from "../src/agents/endpoint";
import {
  checkNavigationTarget,
  isInternalAddress,
} from "../src/computer/target";

/**
 * Where an agent's name actually points, checked before this server dials it.
 *
 * The textual check reads the address as written. These are the addresses it cannot see through:
 * a bare service name on the deployment's own network, and a public-looking name whose DNS answers
 * with a private or metadata address.
 */

const resolvesTo =
  (addresses: string[]) =>
  async (_hostname: string): Promise<string[]> =>
    addresses;

describe("a name is judged by where it resolves", () => {
  test("a public name that resolves to a public address is allowed", async () => {
    const verdict = await checkResolvedAgentHost(
      "https://agent.example.com/ag-ui",
      {
        resolveHost: resolvesTo(["93.184.216.34"]),
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  test.each([
    ["10.0.0.5"],
    ["169.254.169.254"],
    ["127.0.0.1"],
    ["100.64.1.2"],
    ["::1"],
    ["::ffff:10.0.0.5"],
    ["fd00::1"],
  ])("a public name that resolves to %s is refused", async (address) => {
    const verdict = await checkResolvedAgentHost(
      "https://agent.example.com/ag-ui",
      {
        resolveHost: resolvesTo(["93.184.216.34", address]),
      },
    );
    expect(verdict.allowed).toBe(false);
  });

  test("a single-label service name is refused without resolving it", async () => {
    let asked = false;
    const verdict = await checkResolvedAgentHost(
      "http://supervisor:4300/computers",
      {
        resolveHost: async () => {
          asked = true;
          return ["172.18.0.4"];
        },
      },
    );
    expect(verdict.allowed).toBe(false);
    expect(asked).toBe(false);
  });

  test("a name that does not resolve is refused", async () => {
    const verdict = await checkResolvedAgentHost(
      "https://nowhere.example.com/",
      {
        resolveHost: async () => {
          throw new Error("ENOTFOUND");
        },
      },
    );
    expect(verdict.allowed).toBe(false);
  });

  test("a host the deployment named or configured is not resolved", async () => {
    const never = async (): Promise<string[]> => {
      throw new Error("must not resolve");
    };
    expect(
      (
        await checkResolvedAgentHost("http://agent-bot:4200/ag-ui", {
          trustedHosts: trustedHostsOf(["http://agent-bot:4200/ag-ui"]),
          resolveHost: never,
        })
      ).allowed,
    ).toBe(true);
    expect(
      (
        await checkResolvedAgentHost("http://agents.internal:8443/", {
          allowedHosts: new Set(["agents.internal:8443"]),
          resolveHost: never,
        })
      ).allowed,
    ).toBe(true);
  });

  test("the private-host floor being down skips the check, as it does for text", async () => {
    const verdict = await checkResolvedAgentHost("http://supervisor:4300/", {
      allowPrivateHosts: true,
    });
    expect(verdict.allowed).toBe(true);
  });
});

describe("the guarded fetch resolves before every dial", () => {
  test("a stored address whose name points inside is never dialled", async () => {
    let dialled = false;
    const guarded = createAgentFetch({
      resolveHost: resolvesTo(["10.0.0.5"]),
      fetchImpl: (async () => {
        dialled = true;
        return new Response("");
      }) as unknown as typeof fetch,
    });
    await expect(
      guarded("https://agent.example.com/ag-ui", { method: "POST" }),
    ).rejects.toBeInstanceOf(EndpointNotAllowedError);
    expect(dialled).toBe(false);
  });

  test("a redirect to a name that points inside is refused", async () => {
    const dialled: string[] = [];
    const guarded = createAgentFetch({
      resolveHost: async (hostname) =>
        hostname === "agent.example.com"
          ? ["93.184.216.34"]
          : ["169.254.169.254"],
      fetchImpl: (async (url: string) => {
        dialled.push(url);
        return new Response(null, {
          status: 307,
          headers: { location: "https://rebound.example.net/latest" },
        });
      }) as unknown as typeof fetch,
    });
    await expect(
      guarded("https://agent.example.com/ag-ui", { method: "POST" }),
    ).rejects.toBeInstanceOf(EndpointNotAllowedError);
    expect(dialled).toEqual(["https://agent.example.com/ag-ui"]);
  });
});

describe("address ranges the textual check now treats as internal", () => {
  test.each([
    ["http://0.0.0.1/"],
    ["http://100.64.0.1/"],
    ["http://100.127.255.255/"],
  ])("%s is refused", (address) => {
    expect(checkNavigationTarget(address).allowed).toBe(false);
  });

  test("100.63.x and 100.128.x are still public", () => {
    expect(checkNavigationTarget("http://100.63.0.1/").allowed).toBe(true);
    expect(checkNavigationTarget("http://100.128.0.1/").allowed).toBe(true);
  });

  test("isInternalAddress reads resolver output", () => {
    expect(isInternalAddress("10.1.2.3")).toBe(true);
    expect(isInternalAddress("fe80::1")).toBe(true);
    expect(isInternalAddress("8.8.8.8")).toBe(false);
    expect(isInternalAddress("2606:4700::1111")).toBe(false);
  });
});
