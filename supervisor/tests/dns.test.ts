import { describe, expect, test } from "bun:test";
import { parseComputerDnsServers } from "../src/dns";

describe("COMPUTER_DNS_SERVERS", () => {
  test("accepts a deduplicated list of public IPv4 resolvers", () => {
    expect(parseComputerDnsServers("1.1.1.1, 1.0.0.1,1.1.1.1")).toEqual([
      "1.1.1.1",
      "1.0.0.1",
    ]);
  });

  test.each(["10.0.0.2", "100.64.0.1", "127.0.0.1", "169.254.169.254", "1.1.1.256", "resolver.example"])(
    "rejects unsafe resolver %s",
    (value) => {
      expect(() => parseComputerDnsServers(value)).toThrow(
        "COMPUTER_DNS_SERVERS contains an invalid resolver",
      );
    },
  );
});
