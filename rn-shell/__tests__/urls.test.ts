import { describe, expect, test } from "bun:test";
import {
  encodeValue,
  enterUrl,
  handoffPath,
  isOwnOrigin,
  isReloadableOwnUrl,
  isShellAuthUrl,
  originOf,
  pathOf,
  redact,
  renewalTo,
  renewalUrl,
} from "../src/logic/urls";

const origin = "https://my.open.bot";

describe("one query value (the contract's encoding rule)", () => {
  test("worked example and the reserved characters", () => {
    expect(encodeValue("/bots/b1?tab=chat&openbot-renewed=1")).toBe("%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1");
    expect(encodeValue("a-b_c.d~e f!*'()+é")).toBe("a-b_c.d~e%20f%21%2A%27%28%29%2B%C3%A9");
  });
});

describe("hand-off addresses", () => {
  const C = "C".repeat(43);
  test("handoff path in the doc's order", () => {
    expect(handoffPath(C, "ios", "scheme")).toBe(`/api/auth/shell/handoff?challenge=${C}&platform=ios&callback=scheme`);
    expect(handoffPath(C, "android", "https")).toBe(`/api/auth/shell/handoff?challenge=${C}&platform=android&callback=https`);
    expect(handoffPath(C, "ios", null)).toBe(`/api/auth/shell/handoff?challenge=${C}&platform=ios`);
  });
  test("renewal sheet URL matches the doc's example", () => {
    expect(renewalUrl(origin, handoffPath(C, "ios", "https"))).toBe(
      `${origin}/api/auth/hosted/sign-in?returnTo=%2Fapi%2Fauth%2Fshell%2Fhandoff%3Fchallenge%3D${C}%26platform%3Dios%26callback%3Dhttps`,
    );
  });
  test("enter encodes each value", () => {
    expect(enterUrl(origin, "T-1", "V_2.x~", "/bots/b1?tab=chat&openbot-renewed=1")).toBe(
      `${origin}/api/auth/shell/enter?ticket=T-1&verifier=V_2.x~&to=%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1`,
    );
  });
  test("renewal target from returnTo, decoded once, own host only", () => {
    const intercepted = `${origin}/api/auth/hosted/sign-in?returnTo=${encodeValue("https://my.open.bot/bots/b1?tab=chat&openbot-renewed=1")}`;
    const to = renewalTo(intercepted, origin);
    expect(to).toBe("/bots/b1?tab=chat&openbot-renewed=1");
    expect(`to=${encodeValue(to)}`).toBe("to=%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1");
    expect(renewalTo(`${origin}/api/auth/hosted/sign-in`, origin)).toBe("/");
    expect(renewalTo(`${origin}/api/auth/hosted/sign-in?returnTo=${encodeValue("https://evil.example/x")}`, origin)).toBe("/");
    expect(renewalTo(`${origin}/api/auth/hosted/sign-in?returnTo=${encodeValue("//evil.example/x")}`, origin)).toBe("/");
    expect(renewalTo(`${origin}/api/auth/hosted/sign-in?returnTo=${encodeValue("/\\evil")}`, origin)).toBe("/");
    expect(renewalTo(`${origin}/api/auth/hosted/sign-in?returnTo=%2Fbots`, origin)).toBe("/bots");
    expect(renewalTo(`${origin}/api/auth/hosted/sign-in?returnTo=${encodeValue("https://my.open.bot")}`, origin)).toBe("/");
    expect(renewalTo(`${origin}/api/auth/hosted/sign-in?returnTo=${encodeValue("http://my.open.bot/x")}`, origin)).toBe("/");
  });
});

describe("origins", () => {
  test("origin parsing and comparison", () => {
    expect(originOf("https://my.open.bot/sign?x=1")).toBe("https://my.open.bot");
    expect(originOf("https://MY.open.bot:443/")).toBe("https://my.open.bot");
    expect(originOf("http://localhost:3010")).toBe("http://localhost:3010");
    expect(originOf("openbotshell://signed-in?ticket=x")).toBeNull();
    expect(isOwnOrigin("https://my.open.bot.evil.example/", origin)).toBe(false);
    expect(isOwnOrigin("https://evil.example/@my.open.bot", origin)).toBe(false);
    expect(isOwnOrigin("https://user@my.open.bot/", origin)).toBe(true);
    expect(isOwnOrigin("http://my.open.bot/", origin)).toBe(false);
    expect(isOwnOrigin("https://my.open.bot", origin)).toBe(true);
    expect(isOwnOrigin(null, origin)).toBe(false);
  });
  test("paths and what may be reloaded", () => {
    expect(pathOf("https://my.open.bot")).toBe("/");
    expect(pathOf("https://my.open.bot/sign?native-sign-in=web")).toBe("/sign");
    expect(isReloadableOwnUrl("https://my.open.bot/bots", origin)).toBe(true);
    expect(isReloadableOwnUrl("https://my.open.bot/sign", origin)).toBe(false);
    expect(isReloadableOwnUrl("https://my.open.bot/api/auth/shell/enter?ticket=t", origin)).toBe(false);
    expect(isReloadableOwnUrl("https://accounts.google.com/", origin)).toBe(false);
    expect(isShellAuthUrl("https://my.open.bot/api/auth/shell/enter?ticket=t", origin)).toBe(true);
  });
});

describe("redaction", () => {
  test("keeps paths and parameter names, never values", () => {
    expect(redact("https://my.open.bot/api/auth/shell/enter?ticket=SECRET&verifier=SECRET2&to=%2F")).toBe(
      "https://my.open.bot/api/auth/shell/enter?ticket=…&verifier=…&to=…",
    );
    expect(redact("openbotshell://signed-in?ticket=SECRET")).toBe("openbotshell:");
    expect(redact("mailto:someone@example.com")).toBe("mailto:");
    expect(redact("https://my.open.bot/bots")).toBe("https://my.open.bot/bots");
  });
});
