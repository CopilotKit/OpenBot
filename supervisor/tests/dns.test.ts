import { describe, expect, test } from "bun:test";
import { parseComputerDnsServers } from "../src/dns";

describe("COMPUTER_DNS_SERVERS", () => {
  test("accepts a deduplicated list of public IPv4 resolvers", () => {
    expect(parseComputerDnsServers("1.1.1.1, 1.0.0.1,1.1.1.1")).toEqual([
      "1.1.1.1",
      "1.0.0.1",
    ]);
  });

  test.each([
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.255",
    "192.0.3.0",
    "198.17.255.255",
    "198.20.0.0",
    "203.0.112.255",
    "203.0.114.0",
    "223.255.255.255",
  ])("accepts public unicast boundary %s", (value) => {
    expect(parseComputerDnsServers(value)).toEqual([value]);
  });

  test.each([
    "0.0.0.1",
    "10.0.0.2",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.0",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.168.0.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "225.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "254.255.255.255",
    "255.255.255.255",
    "1.1.1.256",
    "resolver.example",
  ])("rejects unsafe resolver %s", (value) => {
    expect(() => parseComputerDnsServers(value)).toThrow(
      "COMPUTER_DNS_SERVERS contains an invalid resolver",
    );
  });
});
