import { describe, expect, test } from "bun:test";
import {
  addressesBeyondThisMachine,
  appListenHosts,
  isAddressLiteral,
  isLoopbackHost,
} from "./this-machine";

describe("this machine's own addresses", () => {
  test("every spelling a socket or a URL gives loopback", () => {
    for (const address of [
      "localhost",
      "LOCALHOST.",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      // A dual-stack socket's IPv4 caller, as Bun's requestIP reports it, and as a URL rewrites it.
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
    ])
      expect(isLoopbackHost(address)).toBe(true);
  });

  test("nothing that another machine, or a name somebody else controls, could be", () => {
    for (const address of [
      "192.168.4.164",
      "10.0.0.5",
      "::ffff:192.168.1.10",
      "[fe80::1]",
      "host.docker.internal",
      "evil.localhost",
      "localhost.evil.example",
      "127.0.0.1.nip.io",
      "0.0.0.0",
      "",
    ])
      expect(isLoopbackHost(address)).toBe(false);
  });

  test("an address typed as one, which no DNS answer stands in for", () => {
    expect(isAddressLiteral("192.168.4.164")).toBe(true);
    expect(isAddressLiteral("[fe80::1]")).toBe(true);
    expect(isAddressLiteral("openbot.local")).toBe(false);
    expect(isAddressLiteral("1.2.3.4.evil.example")).toBe(false);
  });
});

describe("a deployment reached from beyond this machine", () => {
  test("is not what .env.example or OpenBot Desktop write", () => {
    // .env.example
    expect(
      addressesBeyondThisMachine({
        TRUSTED_ORIGINS: "http://localhost:3010",
      }),
    ).toEqual([]);
    // desktop/src-tauri/src/env.rs
    expect(
      addressesBeyondThisMachine({
        TRUSTED_ORIGINS:
          "http://localhost:4567,http://127.0.0.1:4567,http://[::1]:4567",
      }),
    ).toEqual([]);
    expect(appListenHosts({})).toEqual(["127.0.0.1", "::1"]);
  });

  test("is any address on the network an operator names, and one nobody could read", () => {
    expect(
      addressesBeyondThisMachine({
        OPENBOT_APP_URL: "http://192.168.1.10:3010",
        TRUSTED_ORIGINS: "http://localhost:3010, https://box.tailnet.ts.net",
        OPENBOT_PUBLIC_URL: "not a url",
      }),
    ).toEqual([
      "not a url",
      "http://192.168.1.10:3010",
      "https://box.tailnet.ts.net",
    ]);
    expect(
      appListenHosts({ BETTER_AUTH_URL: "https://openbot.example.com" }),
    ).toEqual(["::"]);
  });
});
