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

  test("an address given for OpenBot is allowed as that address alone", () => {
    const literal = personBrowserEgressPolicy({
      native: false,
      allowPrivateHosts: false,
      openbotUrls: ["http://10.0.0.9:3001"],
      gatewayUrl: "ws://[fd00::9]:7103",
    });
    expect(egressDecision(literal, "10.0.0.9", 3001).allowed).toBe(true);
    expect(egressDecision(literal, "fd00::9", 7103).allowed).toBe(true);
    expect(egressDecision(literal, "10.0.0.10", 3001).allowed).toBe(false);
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
