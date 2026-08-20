import { describe, expect, test } from "bun:test";
import {
  checkComputerAddress,
  checkNavigationTarget,
} from "../src/computer/target";

describe("navigation targets", () => {
  test("allows an ordinary public address", () => {
    expect(checkNavigationTarget("https://example.com/pricing")).toEqual({
      allowed: true,
      url: "https://example.com/pricing",
    });
  });

  // Each of these is reachable from the Bot's container and not from the person's laptop, which is
  // the whole reason a browser running inside the deployment needs a floor under it.
  test.each([
    ["http://localhost:5432", "loopback by name"],
    ["http://127.0.0.1/admin", "loopback by address"],
    ["http://10.0.0.5/", "RFC1918 10/8"],
    ["http://192.168.1.1/", "RFC1918 192.168/16"],
    ["http://172.16.4.4/", "RFC1918 172.16/12"],
  ])("refuses %s (%s)", (url) => {
    const verdict = checkNavigationTarget(url);

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain(
      "inside this deployment's own network",
    );
  });

  // Separated from the list above because these are refused under every configuration; the second
  // argument exercises the private-host opt-in explicitly.
  test.each([
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://metadata.google.internal/", "cloud metadata by name"],
  ])("refuses %s (%s) even with private hosts allowed", (url) => {
    for (const allowPrivateHosts of [false, true]) {
      const verdict = checkNavigationTarget(url, { allowPrivateHosts });

      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toContain(
        "cloud credentials",
      );
    }
  });

  test("refuses a non-web scheme, naming it", () => {
    const verdict = checkNavigationTarget("file:///etc/passwd");

    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toBe(
      "Only web addresses are allowed, and that one is file.",
    );
  });

  test("refuses something that is not an address at all", () => {
    expect(checkNavigationTarget("open the pricing page")).toEqual({
      allowed: false,
      reason: "That is not a web address.",
    });
  });

  // A laptop deployment browses its own services on purpose. It has to be asked for explicitly, so
  // that a production deployment cannot reach its own network by forgetting a setting.
  test("allows private hosts only when the deployment opts in", () => {
    expect(checkNavigationTarget("http://localhost:3000").allowed).toBe(false);
    expect(
      checkNavigationTarget("http://localhost:3000", {
        allowPrivateHosts: true,
      }).allowed,
    ).toBe(true);
  });

  // 172.15 and 172.32 sit either side of the private range. Getting the boundary wrong in the safe
  // direction blocks real websites; in the unsafe direction it exposes the network.
  test("gets the edges of the 172.16/12 range right", () => {
    expect(checkNavigationTarget("http://172.15.0.1/").allowed).toBe(true);
    expect(checkNavigationTarget("http://172.32.0.1/").allowed).toBe(true);
    expect(checkNavigationTarget("http://172.31.255.255/").allowed).toBe(false);
  });
});

/**
 * The address a supervisor hands back, before anything is called on it.
 *
 * Not the navigation check. Our own supervisor answers with a loopback address for a container on
 * this machine, so refusing private hosts here would refuse the ordinary case. What is worth
 * checking is that the thing is an address at all, and that it is not the one place a token must
 * never be sent, because with a hosted provider it arrives from somebody else's API.
 */
describe("checkComputerAddress", () => {
  test("allows the private address our own supervisor returns", () => {
    expect(checkComputerAddress("http://127.0.0.1:49213")).toEqual({
      allowed: true,
      url: "http://127.0.0.1:49213/",
    });
  });

  test("allows a hosted provider's public address", () => {
    const verdict = checkComputerAddress("https://sandbox-abc123.example.net");
    expect(verdict.allowed).toBe(true);
  });

  test.each(["169.254.169.254", "metadata.google.internal", "metadata.goog"])(
    "refuses the cloud metadata address %s however it arrived",
    (host) => {
      const verdict = checkComputerAddress(`http://${host}/latest/meta-data/`);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.reason).toContain("cloud credentials");
      }
    },
  );

  test.each(["file:///etc/passwd", "ftp://example.com", "gopher://x"])(
    "refuses %s, which is not a scheme a computer speaks",
    (raw) => {
      expect(checkComputerAddress(raw).allowed).toBe(false);
    },
  );

  test("refuses something that is not a URL", () => {
    const verdict = checkComputerAddress("not-an-address");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain("not a URL");
    }
  });
});
