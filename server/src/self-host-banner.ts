import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";

/** What Intelligence says this deployment is entitled to. Typed from the client OpenBot already uses. */
export type RuntimeEntitlementResponse = Awaited<
  ReturnType<CopilotKitIntelligence["getRuntimeEntitlements"]>
>;

/**
 * The Intelligence plans that pay for it.
 *
 * `free` and `developer` are the no-cost tiers (the license verifier's `LicenseTier`), so they are
 * not here. A self-hosted licence reports its `plan_code`, or its tier when it has none, as the
 * plan code, so the same names cover managed and self-hosted deployments.
 */
const PAID_PLAN_CODES: ReadonlySet<string> = new Set([
  "pro",
  "team",
  "team_self_hosted",
  "enterprise",
]);

/**
 * Whether this deployment pays for Intelligence, read from its runtime entitlement.
 *
 * Only a ready, active entitlement on a paid plan counts, or one bought through AWS Marketplace,
 * which carries no plan code of ours. Everything else, including a free plan, an inactive one, a
 * missing plan code and every non-ready status, is not paying, so the banner shows. Being wrong in
 * that direction costs a dismissable bar; being wrong the other way hides it from the people it is
 * for.
 */
export function paysForIntelligence(
  response: RuntimeEntitlementResponse,
): boolean {
  if (response.status !== "ready" || !response.entitlement.active) return false;
  if (response.entitlement.source === "awsMarketplaceDeploymentLicense")
    return true;
  const plan = response.entitlement.planCode;
  return plan !== undefined && PAID_PLAN_CODES.has(plan);
}

export type SelfHostBanner = {
  /** Whether to offer help self-hosting. Never throws and never waits longer than `waitMs`. */
  shown: () => Promise<boolean>;
};

/**
 * How long a known answer is reused. A plan changes rarely and the bar is promotional, so ten
 * minutes keeps this to six entitlement reads an hour per replica while a plan bought today still
 * hides it within ten minutes.
 */
const ANSWER_TTL_MS = 10 * 60_000;
/** How long a failed read is held before trying again: soon enough to recover, not a hot loop. */
const FAILURE_TTL_MS = 60_000;
/**
 * The longest the first page load waits for an answer nobody has yet. The SDK's own request gives
 * up at 1.5 seconds; a page should not wait that long for a promotional bar, so after this the bar
 * shows and the answer, when it lands, applies to the next load.
 */
const COLD_WAIT_MS = 1_000;

/**
 * Decide, per deployment, whether the self-host banner shows.
 *
 * Off when the operator switched it off, which never asks Intelligence anything. Otherwise on unless
 * the deployment pays for Intelligence. The answer is cached in this process and refreshed in the
 * background when it goes stale, so a page load reads memory, not the network, after the first.
 */
export function createSelfHostBanner(options: {
  enabled: boolean;
  entitlements: () => Promise<RuntimeEntitlementResponse>;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
  waitMs?: number;
  log?: (message: string) => void;
}): SelfHostBanner {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ANSWER_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS;
  const waitMs = options.waitMs ?? COLD_WAIT_MS;
  const log = options.log ?? ((message: string) => console.warn(message));

  let answer: { shown: boolean; expiresAt: number } | undefined;
  let inFlight: Promise<boolean> | undefined;
  // Logged once per run of failures, not once per request: a page load every second against an
  // unreachable Intelligence would otherwise fill the log with the same line.
  let failureLogged = false;

  function refresh(): Promise<boolean> {
    if (inFlight) return inFlight;
    const request = options
      .entitlements()
      .then((response) => {
        const shown = !paysForIntelligence(response);
        answer = { shown, expiresAt: now() + ttlMs };
        failureLogged = false;
        return shown;
      })
      .catch((error: unknown) => {
        if (!failureLogged) {
          failureLogged = true;
          log(
            JSON.stringify({
              type: "self-host-banner-entitlement-unavailable",
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        answer = { shown: true, expiresAt: now() + failureTtlMs };
        return true;
      })
      .finally(() => {
        if (inFlight === request) inFlight = undefined;
      });
    inFlight = request;
    return request;
  }

  return {
    async shown() {
      if (!options.enabled) return false;
      if (answer) {
        if (now() >= answer.expiresAt) void refresh();
        return answer.shown;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), waitMs);
      });
      try {
        return await Promise.race([refresh(), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
