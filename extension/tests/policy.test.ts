import { afterEach, beforeEach, expect, test } from "bun:test";
import { handleExternalConnect } from "../src/background/connection";
import { isAllowedGatewayUrl } from "../src/shared/origin";
import {
  onPolicyChanged,
  type RecorderPolicy,
  readPolicy,
} from "../src/shared/policy";
import { type ChromeFake, installChromeFake } from "./support/chrome-fake";

let fake: ChromeFake;
beforeEach(() => {
  fake = installChromeFake({ manifestVersion: "0.2.0" });
});
afterEach(() => {
  fake.uninstall();
});

test("with no policy the Recorder is unpinned and unrestricted", async () => {
  expect(await readPolicy()).toEqual({
    openbotUrl: null,
    openbotUrlInvalid: false,
    allowedIntelligenceUrls: null,
  });
});

test("a valid OpenBot address is read as its origin", async () => {
  fake.storage.setManaged({ OpenBotUrl: "https://openbot.example.test" });
  expect((await readPolicy()).openbotUrl).toBe("https://openbot.example.test");
});

test("an http address that is not loopback is invalid and the bad string is never returned", async () => {
  fake.storage.setManaged({ OpenBotUrl: "http://openbot.example.test" });
  const policy = await readPolicy();
  expect(policy).toEqual({
    openbotUrl: null,
    openbotUrlInvalid: true,
    allowedIntelligenceUrls: null,
  });
  expect(JSON.stringify(policy)).not.toContain("openbot.example.test");
});

test("an empty or non-string OpenBot address is invalid", async () => {
  for (const value of ["", "   ", 7, "https://x.test/path"]) {
    fake.storage.setManaged({ OpenBotUrl: value });
    expect(await readPolicy()).toMatchObject({
      openbotUrl: null,
      openbotUrlInvalid: true,
    });
  }
});

test("only valid wss addresses (and loopback ws) survive in the allowed list", async () => {
  fake.storage.setManaged({
    AllowedIntelligenceUrls: [
      "wss://gw.example.test",
      "ws://gw.example.test",
      "https://gw.example.test",
      "nonsense",
      42,
      "ws://127.0.0.1:7453",
    ],
  });
  expect((await readPolicy()).allowedIntelligenceUrls).toEqual([
    "wss://gw.example.test",
    "ws://127.0.0.1:7453",
  ]);
});

test("an empty or wholly invalid allowed list refuses every gateway", async () => {
  for (const value of [
    [],
    ["http://gw.example.test"],
    "wss://gw.example.test",
  ]) {
    fake.storage.setManaged({ AllowedIntelligenceUrls: value });
    const { allowedIntelligenceUrls } = await readPolicy();
    expect(allowedIntelligenceUrls).toEqual([]);
    expect(
      isAllowedGatewayUrl(
        "wss://gw.example.test/client",
        allowedIntelligenceUrls,
      ),
    ).toBe(false);
  }
});

test("a pass pointing at an unlisted gateway is refused by the policy's list", async () => {
  fake.storage.setManaged({
    AllowedIntelligenceUrls: ["wss://gw.example.test"],
  });
  const { allowedIntelligenceUrls } = await readPolicy();
  expect(
    isAllowedGatewayUrl(
      "wss://gw.example.test/client",
      allowedIntelligenceUrls,
    ),
  ).toBe(true);
  expect(
    isAllowedGatewayUrl(
      "wss://evil.example.test/client",
      allowedIntelligenceUrls,
    ),
  ).toBe(false);
});

test("onPolicyChanged reports the new policy on a managed change, ignores other areas, and unsubscribes", async () => {
  const seen: RecorderPolicy[] = [];
  const stop = onPolicyChanged((policy) => seen.push(policy));
  await chrome.storage.local.set({
    OpenBotUrl: "https://ignored.example.test",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(seen).toEqual([]);

  fake.storage.setManaged({ OpenBotUrl: "https://openbot.example.test" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(seen).toEqual([
    {
      openbotUrl: "https://openbot.example.test",
      openbotUrlInvalid: false,
      allowedIntelligenceUrls: null,
    },
  ]);

  stop();
  fake.storage.setManaged({ OpenBotUrl: "https://other.example.test" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(seen).toHaveLength(1);
});

test("a policy pinning another address refuses a connect from elsewhere through handleExternalConnect", async () => {
  fake.storage.setManaged({ OpenBotUrl: "https://pinned.example.test" });
  const opened: string[] = [];
  const answer = await handleExternalConnect(
    { type: "openbot.connect", code: "obc_a" },
    { origin: "https://elsewhere.example.test" },
    {
      readPolicy,
      openTab: async (url: string) => {
        opened.push(url);
        return 1;
      },
    },
  );
  expect(answer.ok).toBe(false);
  expect(opened).toEqual([]);
});

test("an invalid policy refuses every connect with policy-invalid", async () => {
  fake.storage.setManaged({ OpenBotUrl: "http://openbot.example.test" });
  expect(
    await handleExternalConnect(
      { type: "openbot.connect", code: "obc_a" },
      { origin: "https://openbot.example.test" },
      { readPolicy, openTab: async () => 1 },
    ),
  ).toEqual({ ok: false, error: "policy-invalid" });
});
