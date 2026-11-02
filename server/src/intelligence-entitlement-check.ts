import type { RuntimeEntitlementResponse } from "./self-host-banner";

/**
 * Whether Intelligence will let this deployment use what it is licensed for, said once at boot.
 *
 * A self-hosted Intelligence without a licence answers every runtime entitlement read with
 * `RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED`, and the features it gates, memory first, are
 * then refused quietly: conversations still run, nothing fails loudly, and nothing in OpenBot's own
 * log says why recall is empty. The licence belongs to Intelligence's own deployment rather than to
 * OpenBot's, which is the part that is easy to miss, so the line says where it goes.
 *
 * Read once and never blocks start-up. The self-host banner reads the same answer on page loads,
 * but only while the banner is enabled, so it cannot be the thing that reports this.
 */
export type EntitlementWarning = {
  type: "intelligence-entitlement-not-ready";
  status: string;
  code?: string;
  message?: string;
  fix: string;
};

/**
 * The codes this build has advice for. A Map, because the code is Intelligence's string rather than
 * this deployment's: a plain object answers `toString` with an inherited function, which is truthy
 * and so takes the place of the sentence the `||` below exists to supply.
 */
const FIXES: ReadonlyMap<string, string> = new Map([
  [
    "RUNTIME_ENTITLEMENTS_SELF_HOSTED_MISCONFIGURED",
    "Intelligence has no valid licence. Give Intelligence's own deployment a COPILOTKIT_LICENSE_TOKEN " +
      "(its Helm chart takes it as appApi.licenseSecret, or externalSecrets.secrets.license); setting it " +
      "on OpenBot alone is not enough. Until then memory and other licensed features are refused.",
  ],
  [
    "RUNTIME_ENTITLEMENTS_SELF_HOSTED_EXPIRED",
    "Intelligence's licence has expired. Renew it and replace COPILOTKIT_LICENSE_TOKEN on Intelligence's " +
      "deployment. Until then memory and other licensed features are refused.",
  ],
  [
    "RUNTIME_ENTITLEMENTS_MANAGED_UNAVAILABLE",
    "Managed Intelligence could not resolve this project's entitlement just now. This is usually " +
      "temporary; licensed features may be refused until it recovers.",
  ],
]);

/** The warning a response deserves, or null when Intelligence answers ready and active. */
export function entitlementWarning(
  response: RuntimeEntitlementResponse,
): EntitlementWarning | null {
  if (response.status === "ready") {
    if (response.entitlement.active) return null;
    return {
      type: "intelligence-entitlement-not-ready",
      status: "inactive",
      fix: "Intelligence answers that this deployment's entitlement is not active, so licensed features such as memory are refused.",
    };
  }
  const code = response.error?.code;
  return {
    type: "intelligence-entitlement-not-ready",
    status: response.status,
    ...(code ? { code } : {}),
    ...(response.error?.message ? { message: response.error.message } : {}),
    fix:
      (code && FIXES.get(code)) ||
      "Intelligence did not confirm this deployment's entitlement, so licensed features such as memory may be refused.",
  };
}

/** Ask once and log what was found. Resolves either way and never throws. */
export async function reportIntelligenceEntitlement(options: {
  entitlements: () => Promise<RuntimeEntitlementResponse>;
  log?: (message: string) => void;
}): Promise<void> {
  const log = options.log ?? ((message: string) => console.warn(message));
  try {
    const warning = entitlementWarning(await options.entitlements());
    if (warning) log(JSON.stringify(warning));
  } catch (error) {
    log(
      JSON.stringify({
        type: "intelligence-entitlement-unreadable",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
