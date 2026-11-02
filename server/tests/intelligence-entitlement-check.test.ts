import { describe, expect, test } from "bun:test";
import {
  entitlementWarning,
  reportIntelligenceEntitlement,
} from "../src/intelligence-entitlement-check";
import type { RuntimeEntitlementResponse } from "../src/self-host-banner";

function ready(active = true): RuntimeEntitlementResponse {
  return {
    status: "ready",
    entitlement: {
      active,
      source: "selfHostedDeploymentLicense",
      features: {},
      limits: {},
      planCode: "enterprise",
    },
  };
}

function notReady(
  status: "degraded" | "misconfigured" | "unavailable",
  code: string,
  message = "not ready",
): RuntimeEntitlementResponse {
  return { status, error: { code, message, retryable: false } };
}

describe("what Intelligence's entitlement answer means for this deployment", () => {
  test("ready and active says nothing", () => {
    expect(entitlementWarning(ready())).toBeNull();
  });

  test("ready but inactive is reported", () => {
    expect(entitlementWarning(ready(false))).toMatchObject({
      status: "inactive",
    });
  });

  test("an unlicensed self-hosted Intelligence names where the licence goes", () => {
    // The state a self-hosted deployment reaches when OpenBot has the licence and Intelligence does
    // not: memory is refused with nothing in OpenBot's log saying why.
    const warning = entitlementWarning(
      notReady(
        "misconfigured",
        "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
        "Self-hosted license configuration is missing or invalid.",
      ),
    );
    expect(warning).toMatchObject({
      type: "intelligence-entitlement-not-ready",
      status: "misconfigured",
      code: "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
      message: "Self-hosted license configuration is missing or invalid.",
    });
    expect(warning?.fix).toContain("Intelligence's own deployment");
    expect(warning?.fix).toContain("appApi.licenseSecret");
    expect(warning?.fix).toContain("memory");
  });

  test("an expired licence says to renew it", () => {
    expect(
      entitlementWarning(
        notReady("misconfigured", "RUNTIME_ENTITLEMENTS_SELF_HOSTED_EXPIRED"),
      )?.fix,
    ).toContain("expired");
  });

  test("an unknown code still says what it costs", () => {
    expect(
      entitlementWarning(notReady("unavailable", "SOMETHING_NEW"))?.fix,
    ).toContain("memory");
  });

  /*
   * The code is Intelligence's string, not ours, so a code borrowed from `Object.prototype` is as
   * unknown as any other and deserves the same sentence. Looked up in a plain object, `toString` is
   * answered with a function, which is truthy and so wins the `||` fallback — leaving `fix` a
   * function where a sentence belongs, and a warning that says nothing wherever it is shown.
   */
  test("a code borrowed from Object.prototype is unknown like any other", () => {
    for (const code of ["toString", "constructor", "valueOf"]) {
      const fix = entitlementWarning(notReady("unavailable", code))?.fix;
      expect(typeof fix).toBe("string");
      expect(fix).toContain("memory");
    }
  });
});

describe("reporting it at boot", () => {
  test("logs one line when the answer is not ready", async () => {
    const lines: string[] = [];
    await reportIntelligenceEntitlement({
      entitlements: async () =>
        notReady(
          "misconfigured",
          "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
        ),
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "intelligence-entitlement-not-ready",
      code: "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
    });
  });

  test("logs nothing when ready", async () => {
    const lines: string[] = [];
    await reportIntelligenceEntitlement({
      entitlements: async () => ready(),
      log: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(0);
  });

  test("an unreachable Intelligence is reported and does not throw", async () => {
    const lines: string[] = [];
    await reportIntelligenceEntitlement({
      entitlements: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      log: (line) => lines.push(line),
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "intelligence-entitlement-unreadable",
      reason: "connect ECONNREFUSED",
    });
  });
});
