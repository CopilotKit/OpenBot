import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import {
  createSelfHostBanner,
  paysForIntelligence,
  type RuntimeEntitlementResponse,
} from "../src/self-host-banner";
import { testEnvironment } from "./support/environment";

type Source =
  | "managedOrgSubscription"
  | "selfHostedDeploymentLicense"
  | "awsMarketplaceDeploymentLicense";

function ready(
  planCode: string | undefined,
  options: { active?: boolean; source?: Source } = {},
): RuntimeEntitlementResponse {
  return {
    status: "ready",
    entitlement: {
      active: options.active ?? true,
      source: options.source ?? "managedOrgSubscription",
      features: {},
      limits: {},
      ...(planCode === undefined ? {} : { planCode }),
    },
  };
}

function notReady(
  status: "degraded" | "misconfigured" | "unavailable",
): RuntimeEntitlementResponse {
  return {
    status,
    error: { code: "X", message: "not ready", retryable: true },
  };
}

describe("whether a deployment pays for Intelligence", () => {
  test.each(["pro", "team", "team_self_hosted", "enterprise"])(
    "%s is a paid plan",
    (plan) => {
      expect(paysForIntelligence(ready(plan))).toBe(true);
      expect(
        paysForIntelligence(
          ready(plan, { source: "selfHostedDeploymentLicense" }),
        ),
      ).toBe(true);
    },
  );

  test.each(["free", "developer", "something_new"])(
    "%s is not a paid plan",
    (plan) => {
      expect(paysForIntelligence(ready(plan))).toBe(false);
    },
  );

  test("an entitlement with no plan code is not paying", () => {
    expect(paysForIntelligence(ready(undefined))).toBe(false);
  });

  test("an AWS Marketplace licence pays, with or without a plan code", () => {
    expect(
      paysForIntelligence(
        ready(undefined, { source: "awsMarketplaceDeploymentLicense" }),
      ),
    ).toBe(true);
  });

  test("an inactive paid entitlement is not paying", () => {
    expect(paysForIntelligence(ready("enterprise", { active: false }))).toBe(
      false,
    );
    expect(
      paysForIntelligence(
        ready(undefined, {
          active: false,
          source: "awsMarketplaceDeploymentLicense",
        }),
      ),
    ).toBe(false);
  });

  test.each(["degraded", "misconfigured", "unavailable"] as const)(
    "a %s entitlement is not paying",
    (status) => {
      expect(paysForIntelligence(notReady(status))).toBe(false);
    },
  );
});

describe("the self-host banner", () => {
  test("is off when the operator switched it off, without asking Intelligence", async () => {
    let asked = 0;
    const banner = createSelfHostBanner({
      enabled: false,
      entitlements: async () => {
        asked += 1;
        return ready("free");
      },
    });
    expect(await banner.shown()).toBe(false);
    expect(asked).toBe(0);
  });

  test("shows on a free plan and hides on a paid one", async () => {
    const free = createSelfHostBanner({
      enabled: true,
      entitlements: async () => ready("free"),
    });
    const paid = createSelfHostBanner({
      enabled: true,
      entitlements: async () => ready("team"),
    });
    expect(await free.shown()).toBe(true);
    expect(await paid.shown()).toBe(false);
  });

  test("shows when the entitlement cannot be read, and says so once", async () => {
    const logged: string[] = [];
    const banner = createSelfHostBanner({
      enabled: true,
      failureTtlMs: 0,
      entitlements: async () => {
        throw new Error("Intelligence is unreachable");
      },
      log: (line) => logged.push(line),
    });
    expect(await banner.shown()).toBe(true);
    expect(await banner.shown()).toBe(true);
    await Bun.sleep(0);
    expect(await banner.shown()).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Intelligence is unreachable");
  });

  test("does not hold a page load longer than it allows", async () => {
    const banner = createSelfHostBanner({
      enabled: true,
      waitMs: 20,
      entitlements: () => new Promise(() => {}),
    });
    const started = performance.now();
    expect(await banner.shown()).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("reuses a known answer instead of asking again", async () => {
    let asked = 0;
    const banner = createSelfHostBanner({
      enabled: true,
      entitlements: async () => {
        asked += 1;
        return ready("enterprise");
      },
    });
    expect(await banner.shown()).toBe(false);
    expect(await banner.shown()).toBe(false);
    expect(await banner.shown()).toBe(false);
    expect(asked).toBe(1);
  });

  test("answers from memory when stale and refreshes behind it", async () => {
    let clock = 0;
    let plan = "pro";
    let asked = 0;
    const banner = createSelfHostBanner({
      enabled: true,
      ttlMs: 100,
      now: () => clock,
      entitlements: async () => {
        asked += 1;
        return ready(plan);
      },
    });
    expect(await banner.shown()).toBe(false);
    plan = "free";
    clock = 200;
    // The stale answer is returned at once; the plan change applies once the refresh lands.
    expect(await banner.shown()).toBe(false);
    await Bun.sleep(0);
    expect(asked).toBe(2);
    expect(await banner.shown()).toBe(true);
  });

  test("asks once for many page loads that arrive together", async () => {
    let asked = 0;
    const banner = createSelfHostBanner({
      enabled: true,
      entitlements: async () => {
        asked += 1;
        await Bun.sleep(5);
        return ready("free");
      },
    });
    const answers = await Promise.all([
      banner.shown(),
      banner.shown(),
      banner.shown(),
    ]);
    expect(answers).toEqual([true, true, true]);
    expect(asked).toBe(1);
  });
});

describe("the capabilities endpoint", () => {
  const config = loadConfig(testEnvironment());

  // createApp takes its services positionally. The banner is the 36th, followed by the identity
  // store and the GitHub sign-in callback, so it is no longer the last of them.
  const SELF_HOST_BANNER_ARG = 35;
  function appWith(banner: ReturnType<typeof createSelfHostBanner>) {
    const args: unknown[] = new Array(createApp.length).fill(undefined);
    args[0] = config;
    args[SELF_HOST_BANNER_ARG] = banner;
    return (createApp as (...input: unknown[]) => ReturnType<typeof createApp>)(
      ...args,
    );
  }

  test("hides the banner from a deployment that pays for Intelligence", async () => {
    const app = appWith(
      createSelfHostBanner({
        enabled: true,
        entitlements: async () => ready("enterprise"),
      }),
    );
    const response = await app.request("/api/capabilities");
    expect((await response.json()).selfHostBanner).toBe(false);
  });

  test("shows it on a free plan", async () => {
    const app = appWith(
      createSelfHostBanner({
        enabled: true,
        entitlements: async () => ready("free"),
      }),
    );
    const response = await app.request("/api/capabilities");
    expect((await response.json()).selfHostBanner).toBe(true);
  });
});
