// Where a person's own OpenBot browser may go, judged by the computer's own filter rule (agent-computer/src/egress.ts,
// which the server imports rather than copies) against real addresses: the open web, OpenBot and the Intelligence
// gateway by name, and nothing a person's laptop could not reach.
import { describe, expect, test } from "bun:test";
import {
  personBrowserEgressPolicy,
  publicInternetRanges,
} from "../src/browser/egress";
import {
  egressDecision,
  parseEgressRules,
} from "../src/computer/policy-network";

const cloud = personBrowserEgressPolicy({
  native: false,
  allowPrivateHosts: false,
  openbotUrls: ["https://openbot.example.com", "https://app.example.com/"],
  gatewayUrl: "wss://gateway.example.com/socket",
});
const allowed = (host: string, resolved: string[] = []) =>
  egressDecision(cloud, host, 443, resolved).allowed;

describe("a person's browser on a computer in the cloud", () => {
  test("reaches the open web, by address and by name", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "142.250.80.46",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "192.0.3.1",
      "2606:4700:4700::1111",
      "2a00:1450:4009:81f::200e",
    ])
      expect([address, allowed(address)]).toEqual([address, true]);
    expect(allowed("example.org", ["93.184.215.14"])).toBe(true);
    expect(
      allowed("example.org", ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"]),
    ).toBe(true);
  });

  test("never reaches inside the deployment: private, loopback, link-local, shared, reserved and multicast space", () => {
    for (const address of [
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "0.0.0.0",
      "100.64.0.1",
      "100.100.100.200",
      "169.254.169.254",
      "169.254.170.2",
      "192.0.2.10",
      "198.18.0.1",
      "224.0.0.251",
      "255.255.255.255",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2001:db8::1",
      "2002:a00:1::1",
    ])
      expect([address, allowed(address)]).toEqual([address, false]);
    // A name is judged by every address it resolves to: one inside is refused, as is one that resolves partly inside.
    expect(allowed("intranet.example", ["10.1.2.3"])).toBe(false);
    expect(allowed("split.example", ["93.184.215.14", "10.1.2.3"])).toBe(false);
  });

  test("reaches OpenBot and the Intelligence gateway by name wherever they resolve, and only those names", () => {
    expect(allowed("openbot.example.com", ["10.0.0.7"])).toBe(true);
    expect(allowed("app.example.com", ["10.0.0.8"])).toBe(true);
    expect(allowed("gateway.example.com", ["172.20.1.1"])).toBe(true);
    expect(allowed("evil.example.com", ["10.0.0.7"])).toBe(false);
    // A cloud's metadata endpoint stays out whatever a name says.
    expect(allowed("openbot.example.com", ["169.254.169.254"])).toBe(false);
  });

  test("OpenBot and the gateway by name are allowed on their own ports, never the name's others", () => {
    // Resolving inside the deployment, where the public ranges do not already allow them: a name on its own port only.
    const port = (host: string, to: number, resolved: string[]) =>
      egressDecision(cloud, host, to, resolved).allowed;
    expect(port("openbot.example.com", 443, ["10.0.0.7"])).toBe(true);
    expect(port("openbot.example.com", 8443, ["10.0.0.7"])).toBe(false);
    expect(port("gateway.example.com", 443, ["172.20.1.1"])).toBe(true);
    expect(port("gateway.example.com", 5432, ["172.20.1.1"])).toBe(false);
    const ported = personBrowserEgressPolicy({
      native: false,
      allowPrivateHosts: false,
      openbotUrls: ["http://openbot.internal:3001"],
      gatewayUrl: "ws://gateway.internal:7103/socket",
    });
    expect(
      egressDecision(ported, "openbot.internal", 3001, ["10.0.0.7"]).allowed,
    ).toBe(true);
    expect(
      egressDecision(ported, "openbot.internal", 80, ["10.0.0.7"]).allowed,
    ).toBe(false);
    expect(
      egressDecision(ported, "gateway.internal", 7103, ["10.0.0.8"]).allowed,
    ).toBe(true);
    expect(
      egressDecision(ported, "gateway.internal", 3001, ["10.0.0.8"]).allowed,
    ).toBe(false);
  });

  test("an address given for OpenBot is allowed as that address alone, on its own port", () => {
    const literal = personBrowserEgressPolicy({
      native: false,
      allowPrivateHosts: false,
      openbotUrls: ["http://10.0.0.9:3001"],
      gatewayUrl: "ws://[fd00::9]:7103",
    });
    expect(egressDecision(literal, "10.0.0.9", 3001).allowed).toBe(true);
    expect(egressDecision(literal, "fd00::9", 7103).allowed).toBe(true);
    expect(egressDecision(literal, "10.0.0.10", 3001).allowed).toBe(false);
    expect(egressDecision(literal, "10.0.0.9", 5432).allowed).toBe(false);
    expect(egressDecision(literal, "fd00::9", 3001).allowed).toBe(false);
  });

  // The end-to-end run's hosted OpenBot: it and the gateway both on 127.0.0.1, and the person's browser loaded the
  // Intelligence UI on 7555 and a probe on 7498 because the address was allowed on every port.
  test("OpenBot and the gateway on one address let the browser reach those two ports, never the address's others", () => {
    const shared = personBrowserEgressPolicy({
      native: false,
      allowPrivateHosts: false,
      openbotUrls: [undefined, "http://127.0.0.1:7460"],
      gatewayUrl: "ws://127.0.0.1:7053/socket",
    });
    const reach = (host: string, port: number, resolved: string[] = []) =>
      egressDecision(shared, host, port, resolved).allowed;
    expect(reach("127.0.0.1", 7460)).toBe(true);
    expect(reach("127.0.0.1", 7053)).toBe(true);
    for (const port of [7555, 7498, 7050, 80, 443, 5432])
      expect([port, reach("127.0.0.1", port)]).toEqual([port, false]);
    // Nor by a name that resolves there, nor by its neighbours.
    expect(reach("intelligence.test", 7555, ["127.0.0.1"])).toBe(false);
    expect(reach("127.0.0.2", 7460)).toBe(false);
    expect(reach("::1", 7460)).toBe(false);
    expect(parseEgressRules(shared.rules)).toEqual({
      ok: true,
      rules: shared.rules,
    });
  });

  test("an origin with no port is allowed on its scheme's own, and localhost on the loopback addresses", () => {
    const defaults = personBrowserEgressPolicy({
      native: false,
      allowPrivateHosts: false,
      openbotUrls: ["https://10.0.0.9", "http://localhost:3010"],
      gatewayUrl: "wss://[fd00::9]/socket",
    });
    const reach = (host: string, port: number, resolved: string[] = []) =>
      egressDecision(defaults, host, port, resolved).allowed;
    expect(reach("10.0.0.9", 443)).toBe(true);
    expect(reach("10.0.0.9", 80)).toBe(false);
    expect(reach("fd00::9", 443)).toBe(true);
    expect(reach("fd00::9", 80)).toBe(false);
    // The browser dialling localhost resolves it, and each address it resolves to must be allowed on that port.
    expect(reach("127.0.0.1", 3010)).toBe(true);
    expect(reach("::1", 3010)).toBe(true);
    expect(reach("localhost", 3010, ["127.0.0.1", "::1"])).toBe(true);
    expect(reach("localhost", 7555, ["127.0.0.1", "::1"])).toBe(false);
    expect(reach("127.0.0.1", 7555)).toBe(false);
  });

  test("is a policy the computer accepts, and the public ranges cover the address space without overlap", () => {
    expect(parseEgressRules(cloud.rules)).toEqual({
      ok: true,
      rules: cloud.rules,
    });
    const ipv4 = publicInternetRanges()
      .filter((range) => !range.includes(":"))
      .map((range) => 2 ** (32 - Number(range.split("/")[1])))
      .reduce((sum, size) => sum + size, 0);
    // All of IPv4 less the special-purpose ranges, counted.
    const notPublic = [8, 8, 10, 8, 16, 12, 24, 24, 24, 16, 15, 24, 24, 4, 4]
      .map((prefix) => 2 ** (32 - prefix))
      .reduce((sum, size) => sum + size, 0);
    expect(ipv4).toBe(2 ** 32 - notPublic);
  });
});

describe("a person's browser that may go everywhere", () => {
  test("on their own desktop, and where the deployment lets Bots reach private hosts", () => {
    for (const policy of [
      personBrowserEgressPolicy({
        native: true,
        allowPrivateHosts: false,
        openbotUrls: [],
        gatewayUrl: "wss://gateway.example.com",
      }),
      personBrowserEgressPolicy({
        native: false,
        allowPrivateHosts: true,
        openbotUrls: [],
        gatewayUrl: "wss://gateway.example.com",
      }),
    ]) {
      expect(policy).toEqual({ mode: "allow_all", rules: [] });
      expect(egressDecision(policy, "192.168.1.20", 80).allowed).toBe(true);
      // Never a cloud's credentials, whatever the policy.
      expect(egressDecision(policy, "169.254.169.254", 80).allowed).toBe(false);
    }
  });
});
